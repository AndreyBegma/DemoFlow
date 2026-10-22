import type {
  Clock,
  RunnerSocket,
  SocketFactory,
  SocketHandlers,
} from '../../src/runner/connection.ts';
import type { Logger, LogLevel } from '../../src/runner/log.ts';

/** Timers that only fire when the test advances time. */
export class FakeClock implements Clock {
  private time = 0;
  private timers: Array<{ at: number; run: () => void; live: boolean }> = [];

  now(): number {
    return this.time;
  }

  after(ms: number, run: () => void): () => void {
    const timer = { at: this.time + ms, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Runs every timer due within `ms`, in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      const next = this.timers
        .filter((timer) => timer.live && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      next.live = false;
      this.time = next.at;
      next.run();
    }
    this.time = end;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

export interface FakeSocket {
  url: string;
  token: string;
  sent: Array<Record<string, unknown>>;
  binary: Uint8Array[];
  closed: { code: number; reason: string } | null;
  handlers: SocketHandlers;
  open(): void;
  receive(message: unknown): void;
  /** The server closes the socket. */
  serverClose(code: number, reason?: string): void;
}

export function fakeSockets(): {
  factory: SocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, token, handlers) => {
    const socket: FakeSocket = {
      url,
      token,
      sent: [],
      binary: [],
      closed: null,
      handlers,
      open: () => handlers.open(),
      receive: (message) =>
        handlers.message(
          typeof message === 'string' ? message : JSON.stringify(message),
        ),
      serverClose: (code, reason = '') => {
        socket.closed = { code, reason };
        handlers.close(code, reason);
      },
    };
    sockets.push(socket);
    const runnerSocket: RunnerSocket = {
      send: (text) => {
        socket.sent.push(JSON.parse(text) as Record<string, unknown>);
      },
      sendBinary: (data) => {
        socket.binary.push(data);
      },
      close: (code, reason) => {
        socket.closed = { code, reason };
      },
    };
    return runnerSocket;
  };
  return { factory, sockets };
}

export function memoryLogger(): Logger & {
  lines: Array<{ level: LogLevel; message: string }>;
  text(): string;
} {
  const lines: Array<{ level: LogLevel; message: string }> = [];
  return {
    lines,
    log: (level, message) => {
      lines.push({ level, message });
    },
    text: () => lines.map((line) => line.message).join('\n'),
  };
}
