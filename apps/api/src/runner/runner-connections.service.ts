import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type RawData, WebSocket } from 'ws';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RunnerAuthService } from './runner-auth.service';
import {
  CLOSE_GOING_AWAY,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_NORMAL,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  type ClientMessage,
  HEARTBEAT_TICK_MS,
  IDLE_TIMEOUT_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  PING_INTERVAL_MS,
  parseClientMessage,
  type ServerMessage,
} from './runner-socket';
import type { RunnerContext } from './runner-token';

/** How long shutdown waits for daemons to acknowledge the close. */
const SHUTDOWN_GRACE_MS = 1000;

interface Connection {
  socket: WebSocket;
  runnerId: string;
  /** Epoch ms of the last frame the daemon sent. */
  lastMessageAt: number;
  lastPingAt: number;
  /** Epoch ms of the `lastSeenAt` the database holds. */
  lastSeenWrittenAt: number;
}

/**
 * The open runner sockets of this API instance (one today, #120): online is
 * "has an entry here", never a column. One socket per machine — a second one
 * replaces the first with `4409`. Heartbeats run on the injected clock, so
 * tests drive `tick()` instead of waiting.
 */
@Injectable()
export class RunnerConnections
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RunnerConnections.name);
  private readonly open = new Map<string, Connection>();
  private timer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly auth: RunnerAuthService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), HEARTBEAT_TICK_MS);
    this.timer.unref();
  }

  /**
   * A deploy restarts the API: say so, so daemons reconnect at once. Waits
   * (briefly) for the close handshakes, since Nest terminates every socket
   * right after this hook.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.timer);
    const sockets = [...this.open.values()].map(({ socket }) => socket);
    this.open.clear();
    const closed = sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          this.send(socket, { type: 'bye', reason: 'shutdown' });
          socket.close(CLOSE_GOING_AWAY, 'shutdown');
        }),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closed),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  isOnline(runnerId: string): boolean {
    return this.open.has(runnerId);
  }

  /** An authenticated socket, straight after the upgrade. */
  async accept(
    socket: WebSocket,
    { runner }: RunnerContext,
    ip: string | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const connection: Connection = {
      socket,
      runnerId: runner.id,
      lastMessageAt: now.getTime(),
      lastPingAt: now.getTime(),
      lastSeenWrittenAt: now.getTime(),
    };
    // Listeners first: a frame that arrives during the writes below counts.
    socket.on('message', (data, isBinary) =>
      this.receive(connection, data, isBinary),
    );
    socket.on('close', () => this.closed(connection));

    const previous = this.open.get(runner.id);
    this.open.set(runner.id, connection);
    if (previous) {
      this.logger.log(
        `Runner ${runner.id} reconnected; closing the older socket`,
      );
      previous.socket.close(CLOSE_REPLACED, 'replaced');
    }

    // Also the check that closes a socket whose machine was revoked between
    // the upgrade and this line.
    const { count } = await this.prisma.runner.updateMany({
      where: { id: runner.id, revokedAt: null },
      data: { lastSeenAt: now, lastSeenIp: ip ?? null },
    });
    if (count !== 1) {
      this.disconnect(runner.id, CLOSE_REVOKED, 'revoked');
      return;
    }

    this.send(socket, {
      type: 'hello',
      runnerId: runner.id,
      serverTime: now.toISOString(),
    });
    const token = await this.auth.startRotation(runner);
    if (token) {
      this.logger.log(`Rotating the token of runner ${runner.id}`);
      this.send(socket, { type: 'rotate', token });
    }
  }

  /** Revocation and the like: the socket goes now, with `code`. */
  disconnect(runnerId: string, code: number, reason: string): void {
    const connection = this.open.get(runnerId);
    if (!connection) {
      return;
    }
    this.open.delete(runnerId);
    connection.socket.close(code, reason);
  }

  /** Pings and the idle timeout. Runs every `HEARTBEAT_TICK_MS`. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const connection of [...this.open.values()]) {
      if (now - connection.lastMessageAt >= IDLE_TIMEOUT_MS) {
        this.logger.log(`Runner ${connection.runnerId} went silent; closing`);
        this.disconnect(
          connection.runnerId,
          CLOSE_HEARTBEAT_TIMEOUT,
          'heartbeat timeout',
        );
      } else if (now - connection.lastPingAt >= PING_INTERVAL_MS) {
        connection.lastPingAt = now;
        this.send(connection.socket, { type: 'ping', at: now });
      }
    }
  }

  private receive(
    connection: Connection,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (this.open.get(connection.runnerId) !== connection) {
      return;
    }
    this.touch(connection);
    const parsed = parseClientMessage(data, isBinary);
    if (!parsed.ok) {
      this.logger.warn(
        `Ignored a frame from runner ${connection.runnerId}: ${parsed.problem}`,
      );
      return;
    }
    this.handle(connection, parsed.message);
  }

  private handle(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.send(connection.socket, { type: 'pong', at: message.at });
        return;
      case 'pong':
        return;
      case 'rotated':
        this.auth
          .completeRotation(connection.runnerId)
          .then((done) => {
            if (!done) {
              this.logger.warn(
                `Runner ${connection.runnerId} acknowledged no live rotation`,
              );
            }
          })
          .catch((error: unknown) => this.logger.error(error));
        return;
      case 'bye':
        this.disconnect(connection.runnerId, CLOSE_NORMAL, 'bye');
        return;
    }
  }

  private touch(connection: Connection): void {
    const now = this.clock.now().getTime();
    connection.lastMessageAt = now;
    if (now - connection.lastSeenWrittenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.writeLastSeen(connection);
    }
  }

  private closed(connection: Connection): void {
    if (this.open.get(connection.runnerId) === connection) {
      this.open.delete(connection.runnerId);
    }
    if (
      !this.shuttingDown &&
      connection.lastMessageAt > connection.lastSeenWrittenAt
    ) {
      this.writeLastSeen(connection);
    }
  }

  private writeLastSeen(connection: Connection): void {
    connection.lastSeenWrittenAt = connection.lastMessageAt;
    this.prisma.runner
      .updateMany({
        where: { id: connection.runnerId, revokedAt: null },
        data: { lastSeenAt: new Date(connection.lastMessageAt) },
      })
      .catch((error: unknown) => this.logger.error(error));
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
