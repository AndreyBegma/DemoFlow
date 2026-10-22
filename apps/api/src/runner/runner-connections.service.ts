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
  type VideoChunk,
  type VideoMessage,
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
  /** A chunk for a stream that is not open was logged on this socket. */
  warnedStrayChunk: boolean;
}

/**
 * Where the video relay (spec #191) hears from the sockets. `chunk` answers
 * false for a stream it does not hold.
 */
export interface VideoSink {
  message(runnerId: string, message: VideoMessage): void;
  chunk(runnerId: string, chunk: VideoChunk): boolean;
  /** The machine's socket is gone: closed, replaced, revoked or shut down. */
  closed(runnerId: string): void;
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
  private videoSink: VideoSink | undefined;

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
    const connections = [...this.open.values()];
    this.open.clear();
    for (const { runnerId } of connections) {
      this.videoSink?.closed(runnerId);
    }
    const sockets = connections.map(({ socket }) => socket);
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

  /** To the machine's current socket; false when it is not online. */
  sendTo(runnerId: string, message: ServerMessage): boolean {
    const connection = this.open.get(runnerId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  /** The video relay's hook (spec #191, Decision 8). One sink per instance. */
  setVideoSink(sink: VideoSink): void {
    this.videoSink = sink;
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
      warnedStrayChunk: false,
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
      // The older socket's streams cannot continue on this one.
      this.videoSink?.closed(runner.id);
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
    this.videoSink?.closed(runnerId);
    connection.socket.close(code, reason);
  }

  /**
   * The machine is gone with its account (spec #177, Decision 3): says
   * `bye revoked` first, so the daemon knows why, then closes with `4401`.
   */
  revoke(runnerId: string): void {
    const connection = this.open.get(runnerId);
    if (!connection) {
      return;
    }
    this.send(connection.socket, { type: 'bye', reason: 'revoked' });
    this.disconnect(runnerId, CLOSE_REVOKED, 'revoked');
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
    if ('chunk' in parsed) {
      this.relayChunk(connection, parsed.chunk);
      return;
    }
    this.handle(connection, parsed.message);
  }

  /**
   * A chunk of a stream that is not open — a late one after a cancel, or a
   * skewed daemon — is dropped, logged once per socket, and the socket stays.
   */
  private relayChunk(connection: Connection, chunk: VideoChunk): void {
    if (this.videoSink?.chunk(connection.runnerId, chunk)) {
      return;
    }
    if (!connection.warnedStrayChunk) {
      connection.warnedStrayChunk = true;
      this.logger.warn(
        `Dropped a video chunk from runner ${connection.runnerId} for a stream that is not open`,
      );
    }
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
      case 'video.head':
      case 'video.end':
      case 'video.error':
        this.videoSink?.message(connection.runnerId, message);
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
      this.videoSink?.closed(connection.runnerId);
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
