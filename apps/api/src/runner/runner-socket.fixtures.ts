import { WebSocket } from 'ws';
import { encodeVideoChunk } from './runner-socket';

/** A daemon stand-in for the runner socket specs. Test code only. */

export interface Received {
  type: string;
  [field: string]: unknown;
}

export interface VideoOpen extends Received {
  streamId: string;
  runId: string;
  format: string;
  range: unknown;
}

export interface ArtifactsDelete extends Received {
  requestId: string;
  runId: string;
}

/** `scenarios.list`, `run.start` or `run.cancel` (spec #247). */
export interface LaunchRequest extends Received {
  requestId: string;
}

export interface Closed {
  code: number;
  reason: string;
}

export class TestSocket {
  readonly received: Received[] = [];
  readonly closed: Promise<Closed>;
  /** The greeting `connect` waited for. */
  hello: Received | undefined;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }
      this.received.push(JSON.parse(data.toString()) as Received);
      for (const wake of this.waiters.splice(0)) {
        wake();
      }
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
  }

  /** Opens and waits for `hello`, i.e. until the server has accepted it. */
  static async connect(
    url: string,
    token: string,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    const socket = new TestSocket(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`Upgrade answered ${res.statusCode}`)),
      );
      ws.once('error', reject);
    });
    socket.hello = await socket.next('hello');
    return socket;
  }

  /** The first message of `type` not consumed yet, waiting for it. */
  async next(type: string, timeoutMs = 2000): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.received.findIndex((m) => m.type === type);
      if (index >= 0) {
        return this.received.splice(index, 1)[0];
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`No ${type} within ${timeoutMs} ms`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** A binary video chunk (spec #191). */
  sendChunk(streamId: string, bytes: Buffer): void {
    this.ws.send(encodeVideoChunk(streamId, bytes), { binary: true });
  }

  /** The next `video.open`, with its stream id as a string. */
  async nextOpen(): Promise<VideoOpen> {
    const open = await this.next('video.open');
    if (typeof open.streamId !== 'string') {
      throw new Error('video.open carries no streamId');
    }
    return open as VideoOpen;
  }

  /** The next `artifacts.delete` (spec #233), with its request id as a string. */
  async nextDelete(): Promise<ArtifactsDelete> {
    const ask = await this.next('artifacts.delete');
    if (typeof ask.requestId !== 'string') {
      throw new Error('artifacts.delete carries no requestId');
    }
    return ask as ArtifactsDelete;
  }

  /** The next `scenarios.list`, `run.start` or `run.cancel`, with its request id. */
  async nextLaunch(
    type: 'scenarios.list' | 'run.start' | 'run.cancel',
  ): Promise<LaunchRequest> {
    const ask = await this.next(type);
    if (typeof ask.requestId !== 'string') {
      throw new Error(`${type} carries no requestId`);
    }
    return ask as LaunchRequest;
  }

  /** `launches.sync` (spec #284): the launch ids this daemon still runs. */
  sync(running: string[]): void {
    this.send({ type: 'launches.sync', running });
  }

  /**
   * Plays the daemon for one stream of `file`: the head for `start`–`end`,
   * the bytes in chunks of `chunkSize`, then `video.end`.
   */
  serve(
    streamId: string,
    file: Buffer,
    { start = 0, end = file.length - 1, chunkSize = 1000 } = {},
  ): void {
    this.send({
      type: 'video.head',
      streamId,
      size: file.length,
      start,
      end,
    });
    for (let at = start; at <= end; at += chunkSize) {
      this.sendChunk(
        streamId,
        file.subarray(at, Math.min(at + chunkSize, end + 1)),
      );
    }
    this.send({ type: 'video.end', streamId });
  }

  /**
   * A ping and its pong: every frame sent before it has been handled when
   * this returns, since the server handles one socket's frames in order.
   */
  async roundTrip(at = 1): Promise<void> {
    this.send({ type: 'ping', at });
    await this.next('pong');
  }

  close(): Promise<Closed> {
    this.ws.close();
    return this.closed;
  }
}

/** The status an upgrade is refused with; fails if a socket opens. */
export function upgradeStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('The upgrade succeeded'));
    });
    ws.once('error', reject);
  });
}

/** Polls `check` until it holds, for effects the server applies async. */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('The condition never held');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
