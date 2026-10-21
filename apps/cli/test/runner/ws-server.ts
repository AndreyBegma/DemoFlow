import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

// A stand-in for the API's runner socket (PR #157): RFC 6455 text and close
// frames only, enough to drive the built-in WebSocket without a dependency.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface ServerConnection {
  authorization: string | undefined;
  messages: Array<Record<string, unknown>>;
  send(message: unknown): void;
  close(code: number, reason?: string): void;
  /** The close frame the client sent, once it did. */
  clientClose: { code: number; reason: string } | null;
  ended: boolean;
}

export interface TestRunnerServer {
  /** `http://127.0.0.1:<port>`: the server a `login` would store. */
  server: string;
  tokens: Set<string>;
  upgrades: Array<{ path: string; authorization: string | undefined }>;
  connections: ServerConnection[];
  /** `GET /api/runner/self`: 401 unless the token is in `tokens`. */
  selfRequests: number;
  /** Sent right after the upgrade, as the API's `hello`. */
  hello: boolean;
  close(): Promise<void>;
}

export async function startRunnerServer(
  tokens: string[],
): Promise<TestRunnerServer> {
  const sockets = new Set<Duplex>();
  const state: TestRunnerServer = {
    server: '',
    tokens: new Set(tokens),
    upgrades: [],
    connections: [],
    selfRequests: 0,
    hello: true,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => http.close(() => resolve()));
    },
  };
  const http: Server = createServer((request, response) => {
    if (request.url === '/api/runner/self') {
      state.selfRequests++;
      const token = bearer(request);
      if (token !== undefined && state.tokens.has(token)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            runnerId: 'runner-1',
            name: 'laptop',
            email: 'a@b',
          }),
        );
      } else {
        response.writeHead(401).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  http.on('upgrade', (request, socket) => {
    state.upgrades.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const token = bearer(request);
    if (
      request.url !== '/api/runner' ||
      token === undefined ||
      !state.tokens.has(token)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = serve(socket, request.headers.authorization);
    state.connections.push(connection);
    if (state.hello) {
      connection.send({
        type: 'hello',
        runnerId: 'runner-1',
        serverTime: new Date().toISOString(),
      });
    }
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  state.server = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return state;
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function serve(
  socket: Duplex,
  authorization: string | undefined,
): ServerConnection {
  let buffer = Buffer.alloc(0);
  const connection: ServerConnection = {
    authorization,
    messages: [],
    clientClose: null,
    ended: false,
    send: (message) => {
      if (!connection.ended)
        socket.write(frame(1, Buffer.from(JSON.stringify(message))));
    },
    close: (code, reason = '') => {
      if (connection.ended) return;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      socket.write(frame(8, payload));
      connection.ended = true;
      socket.end();
    },
  };
  socket.on('close', () => {
    connection.ended = true;
  });
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = parse(buffer);
      if (parsed === null) return;
      buffer = buffer.subarray(parsed.length);
      if (parsed.opcode === 1) {
        connection.messages.push(
          JSON.parse(parsed.payload.toString('utf8')) as Record<
            string,
            unknown
          >,
        );
      } else if (parsed.opcode === 8) {
        const code =
          parsed.payload.length >= 2 ? parsed.payload.readUInt16BE(0) : 1005;
        connection.clientClose = {
          code,
          reason: parsed.payload.subarray(2).toString('utf8'),
        };
        connection.close(code === 1005 ? 1000 : code);
      }
    }
  });
  return connection;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, payload]);
}

/** One masked client frame, or `null` while it is incomplete. */
function parse(
  buffer: Buffer,
): { opcode: number; payload: Buffer; length: number } | null {
  if (buffer.length < 2) return null;
  const opcode = (buffer[0] ?? 0) & 0x0f;
  let length = (buffer[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return { opcode, payload, length: offset + 4 + length };
}
