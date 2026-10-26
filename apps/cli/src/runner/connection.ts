import { apiBase } from '../auth/server.ts';
import type { ArtifactsPort } from './artifacts/index.ts';
import {
  type LaunchPort,
  type LaunchSender,
  RUN_OPTIONS,
} from './launch/index.ts';
import type { Logger } from './log.ts';
import type { RelaySender, VideoRelayPort } from './relay/index.ts';
import type { ConnectionState } from './state.ts';

/** Decision 6: each side pings every 25 s and gives up after 60 s of silence. */
export const PING_MS = 25_000;
export const IDLE_MS = 60_000;
/** Decision 7: 1 s doubling to 60 s, ±20 %, reset after 60 s connected. */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER = 0.2;
export const STABLE_MS = 60_000;
/** How long `stop` waits for the server to close after the daemon's `bye`. */
export const BYE_WAIT_MS = 2_000;

/** Close codes of the PR #157 contract. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_HEARTBEAT = 4408;

export interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(code: number, reason: string): void;
}

/** The part of a WebSocket the client uses; tests replace it. */
export interface RunnerSocket {
  send(text: string): void;
  /** A video chunk (spec 191, "Binary chunk"). */
  sendBinary(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export type SocketFactory = (
  url: string,
  token: string,
  handlers: SocketHandlers,
) => RunnerSocket;

/** Timers as a cancel function, so a fake clock is a sorted list. */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface ConnectionDeps {
  server: string;
  token: string;
  runnerId: string;
  connect: SocketFactory;
  clock: Clock;
  random(): number;
  logger: Logger;
  /** Writes `credentials.json` with the rotated token, atomically. */
  saveToken(token: string): void;
  /** After a refused upgrade: is the token revoked (`GET /runner/self` is 401)? */
  isRevoked(token: string): Promise<boolean>;
  onState(state: ConnectionState, retryAt?: number): void;
  /** Answers `video.*` (spec 192); without it they are logged as unknown. */
  relay?: VideoRelayPort;
  /** Answers `artifacts.delete` (spec 234); without it, logged as unknown. */
  artifacts?: ArtifactsPort;
  /** Answers `scenarios.list` and `run.*` (spec 248); without it, logged as unknown. */
  launches?: LaunchPort;
  /**
   * Spec 361, Decision 6: the current `schedules.sync`, sent after
   * `launches.sync`; `null` while the scheduler has not looked yet.
   */
  schedules?: () => Record<string, unknown> | null;
}

export type ConnectionOutcome = 'stopped' | 'revoked';

/** `wss://<server>/api/runner`; `ws://` for an `http://` server. */
export function socketUrl(server: string): string {
  return `${apiBase(server).replace(/^http/, 'ws')}/runner`;
}

/** The delay before attempt `attempt` (0-based), jittered and capped. */
export function backoffDelay(attempt: number, random: number): number {
  const base = BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16);
  const jitter = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random;
  return Math.round(Math.min(BACKOFF_MAX_MS, base * jitter));
}

/**
 * The daemon's side of the runner socket: connect, heartbeat, rotate, and
 * reconnect with backoff until stopped or revoked.
 */
export class RunnerConnection {
  private readonly deps: ConnectionDeps;
  private token: string;
  private socket: RunnerSocket | null = null;
  private opened = false;
  private openedAt = 0;
  private attempt = 0;
  private stopping = false;
  private finished = false;
  private cancelPing: (() => void) | null = null;
  private cancelIdle: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private cancelBye: (() => void) | null = null;
  private resolve: (outcome: ConnectionOutcome) => void = () => {};
  private readonly done: Promise<ConnectionOutcome>;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
    this.token = deps.token;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Resolves once the daemon was stopped or the token revoked. */
  run(): Promise<ConnectionOutcome> {
    this.connect();
    return this.done;
  }

  /** Sends `bye`, waits up to 2 s for the server to close, and finishes. */
  stop(reason = 'stopped'): Promise<ConnectionOutcome> {
    if (this.finished || this.stopping) return this.done;
    this.stopping = true;
    this.cancelRetry?.();
    const socket = this.socket;
    if (socket === null || !this.opened) {
      if (socket !== null) {
        this.socket = null;
        this.clearTimers();
        socket.close(1000, 'bye');
      }
      this.finish('stopped');
      return this.done;
    }
    this.send({ type: 'bye', reason });
    this.cancelBye = this.deps.clock.after(BYE_WAIT_MS, () => {
      this.drop(1000, 'bye');
    });
    return this.done;
  }

  /** Spec 361, Decision 6: a watched schedule changed; tell an open socket. */
  syncSchedules(): void {
    if (!this.opened || this.stopping) return;
    const frame = this.deps.schedules?.() ?? null;
    if (frame !== null) this.send(frame);
  }

  private connect(): void {
    if (this.stopping) return;
    this.opened = false;
    this.deps.onState('connecting');
    this.deps.logger.log('info', `connecting to ${this.deps.server}`);
    let socket: RunnerSocket | null = null;
    const current = () => socket !== null && this.socket === socket;
    socket = this.deps.connect(socketUrl(this.deps.server), this.token, {
      open: () => {
        if (current()) this.onOpen();
      },
      message: (data) => {
        if (current()) this.onMessage(data);
      },
      close: (code, reason) => {
        if (current()) this.onClose(code, reason);
      },
    });
    this.socket = socket;
    // A connect that hangs before the upgrade counts as silence too.
    this.resetIdle();
  }

  private onOpen(): void {
    this.opened = true;
    this.openedAt = this.deps.clock.now();
    this.deps.logger.log('info', 'connected');
    this.deps.onState('connected');
    // Spec 285, Decision 1: the first frame on every socket, before anything
    // is handled, so the API can reattach the launches this machine still runs.
    const running = this.deps.launches?.running() ?? [];
    // Spec 326, Decision 1: a connection without a launcher ignores run.start,
    // so it claims no options.
    const runOptions = this.deps.launches !== undefined ? [...RUN_OPTIONS] : [];
    this.send({
      type: 'launches.sync',
      running,
      runOptions,
      // Spec 360, Decision 6: a daemon that handles launches runs check passes.
      ...(this.deps.launches !== undefined ? { checks: true } : {}),
    });
    this.deps.logger.log(
      'info',
      `announced ${running.length} running launch${running.length === 1 ? '' : 'es'}`,
    );
    this.syncSchedules();
    this.resetIdle();
    this.schedulePing();
  }

  private onMessage(data: unknown): void {
    this.resetIdle();
    if (typeof data !== 'string') {
      this.deps.logger.log('warn', 'ignored a binary frame');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.deps.logger.log('warn', 'ignored a frame that is not JSON');
      return;
    }
    if (typeof message !== 'object' || message === null) {
      this.deps.logger.log('warn', 'ignored a frame that is not an object');
      return;
    }
    const fields = message as Record<string, unknown>;
    switch (fields.type) {
      case 'hello':
        this.onHello(fields.runnerId);
        return;
      case 'ping':
        this.send({ type: 'pong', at: fields.at });
        return;
      case 'pong':
        return;
      case 'rotate':
        this.onRotate(fields.token);
        return;
      case 'bye':
        this.deps.logger.log(
          'info',
          `the server is closing (${typeof fields.reason === 'string' ? fields.reason : 'no reason'})`,
        );
        return;
      case 'video.open':
      case 'video.ack':
      case 'video.cancel':
        if (this.deps.relay !== undefined) {
          this.deps.relay.handle(fields, this.relaySender());
          return;
        }
        break;
      case 'artifacts.delete':
        if (this.deps.artifacts !== undefined) {
          this.deps.artifacts.handle(fields, this.relaySender());
          return;
        }
        break;
      case 'scenarios.list':
      case 'run.start':
      case 'run.cancel':
        if (this.deps.launches !== undefined) {
          this.deps.launches.handle(
            fields,
            this.relaySender(),
            this.currentSender(),
          );
          return;
        }
        break;
    }
    this.deps.logger.log(
      'warn',
      `ignored a message of type ${JSON.stringify(fields.type)?.slice(0, 64)}`,
    );
  }

  /** Frames for the socket that is current now, and for no later one. */
  private relaySender(): RelaySender {
    const socket = this.socket;
    return {
      send: (message) => {
        if (this.socket === socket) this.send(message);
      },
      sendBinary: (data) => {
        if (socket === null || this.socket !== socket) return;
        try {
          socket.sendBinary(data);
        } catch {
          // The socket is closing; its close ends the stream.
        }
      },
    };
  }

  /**
   * Frames for whichever socket is open when they are sent (spec 248,
   * Decision 10): a run outlives the socket that started it.
   */
  private currentSender(): LaunchSender {
    return {
      send: (message) => {
        if (this.opened) this.send(message);
      },
    };
  }

  private onHello(runnerId: unknown): void {
    if (runnerId === this.deps.runnerId) {
      this.deps.logger.log(
        'info',
        `hello from the server as runner ${runnerId}`,
      );
      return;
    }
    this.deps.logger.log(
      'warn',
      `the server greeted runner ${String(runnerId)}, but credentials.json names ${this.deps.runnerId}`,
    );
  }

  /** Decision 8: the new token is on disk before the server hears `rotated`. */
  private onRotate(token: unknown): void {
    if (typeof token !== 'string' || !token.startsWith('dfr_')) {
      this.deps.logger.log('warn', 'ignored a rotate without a token');
      return;
    }
    try {
      this.deps.saveToken(token);
    } catch (error) {
      // No ack: the old token keeps working, and the next connect retries.
      this.deps.logger.log(
        'error',
        `could not save the rotated token: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.token = token;
    this.send({ type: 'rotated' });
    this.deps.logger.log('info', 'token rotated');
  }

  private onClose(code: number, reason: string): void {
    const wasOpen = this.opened;
    this.socket = null;
    // Decision 7: no file handle outlives the socket it streamed to.
    this.deps.relay?.closeAll();
    this.opened = false;
    this.clearTimers();
    this.deps.logger.log(
      'info',
      `disconnected (${code}${reason === '' ? '' : ` ${reason}`})`,
    );
    if (this.stopping) {
      this.finish('stopped');
      return;
    }
    if (code === CLOSE_REVOKED) {
      this.revoked();
      return;
    }
    if (wasOpen) {
      if (this.deps.clock.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
      this.scheduleRetry();
      return;
    }
    // A refused upgrade is a bare 1006: only /runner/self can tell a 401.
    this.deps.isRevoked(this.token).then(
      (revoked) => {
        if (this.finished) return;
        if (this.stopping) this.finish('stopped');
        else if (revoked) this.revoked();
        else this.scheduleRetry();
      },
      () => {
        if (this.finished) return;
        if (this.stopping) this.finish('stopped');
        else this.scheduleRetry();
      },
    );
  }

  private revoked(): void {
    this.deps.logger.log(
      'warn',
      'revoked: this machine was removed from the account; not reconnecting',
    );
    this.deps.onState('revoked');
    this.finish('revoked');
  }

  private scheduleRetry(): void {
    const delay = backoffDelay(this.attempt, this.deps.random());
    this.attempt++;
    const retryAt = this.deps.clock.now() + delay;
    this.deps.logger.log(
      'info',
      `reconnecting in ${(delay / 1000).toFixed(1)}s`,
    );
    this.deps.onState('reconnecting', retryAt);
    this.cancelRetry = this.deps.clock.after(delay, () => {
      this.cancelRetry = null;
      this.connect();
    });
  }

  private schedulePing(): void {
    this.cancelPing = this.deps.clock.after(PING_MS, () => {
      this.send({ type: 'ping', at: this.deps.clock.now() });
      this.deps.onState('connected');
      this.schedulePing();
    });
  }

  private resetIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.deps.clock.after(IDLE_MS, () => {
      this.deps.logger.log('warn', 'heartbeat timeout: no frame for 60 s');
      this.drop(CLOSE_HEARTBEAT, 'heartbeat timeout');
    });
  }

  /** Closes without waiting for the close handshake of a peer that may be gone. */
  private drop(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === null) return;
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
    this.onClose(code, reason);
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch (error) {
      this.deps.logger.log(
        'warn',
        `could not send ${String(message.type)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private clearTimers(): void {
    for (const cancel of [this.cancelPing, this.cancelIdle, this.cancelBye]) {
      cancel?.();
    }
    this.cancelPing = null;
    this.cancelIdle = null;
    this.cancelBye = null;
  }

  private finish(outcome: ConnectionOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.deps.relay?.closeAll();
    this.cancelRetry?.();
    this.resolve(outcome);
  }
}

/** The built-in WebSocket of Node 22+ (Decision 4); the token goes in a header only. */
export const nodeSocket: SocketFactory = (url, token, handlers) => {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  socket.addEventListener('open', () => handlers.open());
  socket.addEventListener('message', (event) => handlers.message(event.data));
  // Every `error` is followed by a `close`, which carries the code.
  socket.addEventListener('close', (event) =>
    handlers.close(event.code, event.reason),
  );
  return {
    send: (text) => socket.send(text),
    sendBinary: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
};
