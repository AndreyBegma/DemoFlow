import { WebSocket } from 'ws';

/** A daemon stand-in for the runner socket specs. Test code only. */

export interface Received {
  type: string;
  [field: string]: unknown;
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
    ws.on('message', (data) => {
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
