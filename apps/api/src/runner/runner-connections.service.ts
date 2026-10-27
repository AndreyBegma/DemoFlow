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
  type ArtifactsMessage,
  CLOSE_GOING_AWAY,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_NORMAL,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  type ClientMessage,
  FEATURES,
  type Feature,
  HEARTBEAT_TICK_MS,
  IDLE_TIMEOUT_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  type LaunchMessage,
  PING_INTERVAL_MS,
  type ProjectMessage,
  parseClientMessage,
  RUN_OPTIONS,
  type RunOption,
  type SchedulesMessage,
  type ServerMessage,
  type ShareMessage,
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
  /** An `artifacts.*` answer for no pending request was logged on this socket. */
  warnedStrayArtifacts: boolean;
  /** A `scenarios.*`, `run.*` or `launches.sync` frame for no pending request or launch was logged on this socket. */
  warnedStrayLaunch: boolean;
  /** The known `run.start` options this socket's `launches.sync` announced (spec #325, Decision 4). */
  runOptions: RunOption[];
  /** The known features the same frame announced (spec #347, Decision 6). */
  features: Feature[];
  /** Whether the same frame said it answers `check.start` (spec 360); null before it. */
  checks: boolean | null;
  /** A `share.*` answer for no pending request was logged on this socket. */
  warnedStrayShare: boolean;
  /** A `project.*` answer for no pending request was logged on this socket. */
  warnedStrayProject: boolean;
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
 * Where artifact deletion (spec #233) hears from the sockets. `message`
 * answers false for a request it does not hold.
 */
export interface ArtifactsSink {
  message(runnerId: string, message: ArtifactsMessage): boolean;
  /** The machine's socket is gone: closed, replaced, revoked or shut down. */
  closed(runnerId: string): void;
}

/**
 * Where website-started runs (spec #247) hear from the sockets. `message`
 * answers false for a request or launch it does not hold.
 */
export interface LaunchSink {
  message(runnerId: string, message: LaunchMessage): boolean;
  /** A socket became the machine's current one (spec #284, Decision 4). */
  opened(runnerId: string): void;
  /** The machine's socket is gone: closed, replaced, revoked or shut down. */
  closed(runnerId: string): void;
}

/**
 * Where share uploads (spec #347) hear from the sockets. `message` answers
 * false for a request it does not hold.
 */
export interface ShareSink {
  message(runnerId: string, message: ShareMessage): boolean;
  /** The machine's socket is gone: closed, replaced, revoked or shut down. */
  closed(runnerId: string): void;
}

/** Where check schedules (spec #362) hear a machine's config schedules. */
export interface SchedulesSink {
  sync(runnerId: string, message: SchedulesMessage): void;
}

/**
 * Where folder requests (spec #378) hear from the sockets. `message` answers
 * false for a request it does not hold.
 */
export interface ProjectSink {
  message(runnerId: string, message: ProjectMessage): boolean;
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
  private artifactsSink: ArtifactsSink | undefined;
  private launchSink: LaunchSink | undefined;
  private shareSink: ShareSink | undefined;
  private projectSink: ProjectSink | undefined;
  private schedulesSink: SchedulesSink | undefined;

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
      this.socketGone(runnerId);
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

  /** What the machine's current socket accepts on `run.start`; none offline or before its sync. */
  runOptions(runnerId: string): readonly RunOption[] {
    return this.open.get(runnerId)?.runOptions ?? [];
  }

  /** What the machine's current socket can do (spec #347); none offline or before its sync. */
  features(runnerId: string): readonly Feature[] {
    return this.open.get(runnerId)?.features ?? [];
  }

  /**
   * Whether the machine's current socket answers `check.start` (spec #362,
   * Decision 4); null offline or before its `launches.sync`.
   */
  checks(runnerId: string): boolean | null {
    return this.open.get(runnerId)?.checks ?? null;
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

  /** Artifact deletion's hook (spec #233, Decision 8). One sink per instance. */
  setArtifactsSink(sink: ArtifactsSink): void {
    this.artifactsSink = sink;
  }

  /** Website-started runs' hook (spec #247, Decision 10). One sink per instance. */
  setLaunchSink(sink: LaunchSink): void {
    this.launchSink = sink;
  }

  /** Share uploads' hook (spec #347). One sink per instance. */
  setShareSink(sink: ShareSink): void {
    this.shareSink = sink;
  }

  /** Folder requests' hook (spec #378). One sink per instance. */
  setProjectSink(sink: ProjectSink): void {
    this.projectSink = sink;
  }

  /** Check schedules' hook (spec #362). One sink per instance. */
  setSchedulesSink(sink: SchedulesSink): void {
    this.schedulesSink = sink;
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
      warnedStrayArtifacts: false,
      warnedStrayLaunch: false,
      runOptions: [],
      features: [],
      checks: null,
      warnedStrayShare: false,
      warnedStrayProject: false,
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
      // The older socket's streams and requests cannot continue on this one.
      this.socketGone(runner.id);
      previous.socket.close(CLOSE_REPLACED, 'replaced');
    }
    // Before any await: the daemon's `launches.sync` is its first frame.
    this.launchSink?.opened(runner.id);

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
    this.socketGone(runnerId);
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
      case 'artifacts.deleted':
      case 'artifacts.error':
        this.relayArtifacts(connection, message);
        return;
      case 'scenarios.listed':
      case 'scenarios.error':
      case 'run.started':
      case 'run.error':
      case 'run.finished':
      case 'run.progress':
      case 'check.started':
      case 'check.finished':
      case 'check.error':
        this.relayLaunch(connection, message);
        return;
      case 'launches.sync':
        // Unknown options and features are dropped without a log (specs #325, #347).
        connection.runOptions = RUN_OPTIONS.filter((option) =>
          message.runOptions?.includes(option),
        );
        connection.features = FEATURES.filter((feature) =>
          message.features?.includes(feature),
        );
        connection.checks = message.checks === true;
        this.relayLaunch(connection, message);
        return;
      case 'schedules.sync':
        this.schedulesSink?.sync(connection.runnerId, message);
        return;
      case 'share.prepared':
      case 'share.error':
        this.relayShare(connection, message);
        return;
      case 'project.inspected':
      case 'project.initialised':
      case 'project.registered':
      case 'project.error':
        this.relayProject(connection, message);
        return;
    }
  }

  /** As `relayArtifacts`, with its own once-per-socket warning. */
  private relayLaunch(connection: Connection, message: LaunchMessage): void {
    if (this.launchSink?.message(connection.runnerId, message)) {
      return;
    }
    if (!connection.warnedStrayLaunch) {
      connection.warnedStrayLaunch = true;
      this.logger.warn(
        `Dropped ${message.type} from runner ${connection.runnerId} for a request that is not pending`,
      );
    }
  }

  /** As `relayArtifacts`, with its own once-per-socket warning. */
  private relayShare(connection: Connection, message: ShareMessage): void {
    if (this.shareSink?.message(connection.runnerId, message)) {
      return;
    }
    if (!connection.warnedStrayShare) {
      connection.warnedStrayShare = true;
      this.logger.warn(
        `Dropped ${message.type} from runner ${connection.runnerId} for a request that is not pending`,
      );
    }
  }

  /** As `relayArtifacts`, with its own once-per-socket warning. */
  private relayProject(connection: Connection, message: ProjectMessage): void {
    if (this.projectSink?.message(connection.runnerId, message)) {
      return;
    }
    if (!connection.warnedStrayProject) {
      connection.warnedStrayProject = true;
      this.logger.warn(
        `Dropped ${message.type} from runner ${connection.runnerId} for a request that is not pending`,
      );
    }
  }

  /**
   * An answer for no pending request — a late one after a timeout, or a
   * skewed daemon — is dropped, logged once per socket, and the socket stays.
   */
  private relayArtifacts(
    connection: Connection,
    message: ArtifactsMessage,
  ): void {
    if (this.artifactsSink?.message(connection.runnerId, message)) {
      return;
    }
    if (!connection.warnedStrayArtifacts) {
      connection.warnedStrayArtifacts = true;
      this.logger.warn(
        `Dropped ${message.type} from runner ${connection.runnerId} for a request that is not pending`,
      );
    }
  }

  private socketGone(runnerId: string): void {
    this.videoSink?.closed(runnerId);
    this.artifactsSink?.closed(runnerId);
    this.launchSink?.closed(runnerId);
    this.shareSink?.closed(runnerId);
    this.projectSink?.closed(runnerId);
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
      this.socketGone(connection.runnerId);
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
