import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  type ConnectionOutcome,
  IDLE_MS,
  PING_MS,
  RunnerConnection,
  socketUrl,
} from '../../src/runner/connection.ts';
import type {
  RelaySender,
  VideoRelayPort,
} from '../../src/runner/relay/index.ts';
import type { ConnectionState } from '../../src/runner/state.ts';
import {
  FakeClock,
  type FakeSocket,
  fakeSockets,
  memoryLogger,
  settle,
} from './fakes.ts';

const TOKEN = 'dfr_old-token';
const NEW_TOKEN = 'dfr_new-token';

let clock: FakeClock;
let sockets: FakeSocket[];
let logger: ReturnType<typeof memoryLogger>;
let states: Array<{ state: ConnectionState; retryAt?: number }>;
let saved: string[];
let revokedAnswer: boolean | Error;
let connection: RunnerConnection;
let outcome: ConnectionOutcome | null;
let order: string[];

function start(random = 0.5, relay?: VideoRelayPort) {
  const fake = fakeSockets();
  sockets = fake.sockets;
  connection = new RunnerConnection({
    server: 'https://demoflow.test',
    token: TOKEN,
    runnerId: 'runner-1',
    connect: fake.factory,
    clock,
    random: () => random,
    logger,
    saveToken: (token) => {
      order.push('saved');
      saved.push(token);
    },
    isRevoked: async () => {
      if (revokedAnswer instanceof Error) throw revokedAnswer;
      return revokedAnswer;
    },
    onState: (state, retryAt) => {
      states.push(retryAt === undefined ? { state } : { state, retryAt });
    },
    ...(relay === undefined ? {} : { relay }),
  });
  void connection.run().then((value) => {
    outcome = value;
  });
}

function last(): FakeSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  return socket;
}

beforeEach(() => {
  clock = new FakeClock();
  logger = memoryLogger();
  states = [];
  saved = [];
  revokedAnswer = false;
  outcome = null;
  order = [];
});

describe('socketUrl', () => {
  it('turns the stored server into the runner socket under /api', () => {
    expect(socketUrl('https://demoflow.test')).toBe(
      'wss://demoflow.test/api/runner',
    );
    expect(socketUrl('http://localhost:3670')).toBe(
      'ws://localhost:3670/api/runner',
    );
  });
});

describe('backoffDelay', () => {
  it('doubles from 1 s, with ±20 % jitter, capped at 60 s', () => {
    expect(backoffDelay(0, 0.5)).toBe(1_000);
    expect(backoffDelay(0, 0)).toBe(800);
    expect(backoffDelay(0, 1)).toBe(1_200);
    expect(backoffDelay(3, 0.5)).toBe(8_000);
    expect(backoffDelay(6, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(40, 1)).toBe(BACKOFF_MAX_MS);
  });
});

describe('RunnerConnection', () => {
  it('connects with the token, answers pings and sends its own every 25 s', async () => {
    start();
    const socket = last();
    expect(socket.url).toBe('wss://demoflow.test/api/runner');
    expect(socket.token).toBe(TOKEN);
    socket.open();
    socket.receive({ type: 'hello', runnerId: 'runner-1', serverTime: '' });
    socket.receive({ type: 'ping', at: 42 });
    expect(socket.sent).toEqual([{ type: 'pong', at: 42 }]);

    await clock.advance(PING_MS);
    expect(socket.sent.at(-1)).toEqual({ type: 'ping', at: PING_MS });
    expect(states.at(-1)?.state).toBe('connected');
  });

  it('closes with 4408 after 60 s without a frame and reconnects', async () => {
    start();
    last().open();
    await clock.advance(IDLE_MS - 1);
    expect(last().closed).toBeNull();
    await clock.advance(1);
    expect(sockets[0]?.closed).toEqual({
      code: 4408,
      reason: 'heartbeat timeout',
    });
    expect(states.at(-1)?.state).toBe('reconnecting');
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('counts any frame as a sign of life', async () => {
    start();
    last().open();
    await clock.advance(IDLE_MS - 1_000);
    last().receive({ type: 'pong', at: 1 });
    await clock.advance(IDLE_MS - 1_000);
    expect(last().closed).toBeNull();
  });

  it('ignores what it cannot read without closing', () => {
    start();
    const socket = last();
    socket.open();
    socket.receive('not json');
    socket.handlers.message(new ArrayBuffer(4));
    socket.receive({ type: 'job', id: 1 });
    socket.receive([1, 2]);
    expect(socket.closed).toBeNull();
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(
      4,
    );
  });

  it('reconnects with delays that grow and are capped at 60 s', async () => {
    start(1);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      last().serverClose(1006);
      await settle();
      const retry = states.at(-1);
      expect(retry?.state).toBe('reconnecting');
      const wait = (retry?.retryAt ?? 0) - clock.now();
      delays.push(wait);
      await clock.advance(wait);
    }
    expect(delays).toEqual([
      1_200, 2_400, 4_800, 9_600, 19_200, 38_400, 60_000, 60_000, 60_000,
    ]);
    expect(logger.text()).toContain('reconnecting in 60.0s');
    expect(sockets).toHaveLength(10);
  });

  it('resets the backoff after a connection that stayed up 60 s', async () => {
    start();
    for (let attempt = 0; attempt < 4; attempt++) {
      last().serverClose(1006);
      await settle();
      await clock.advance(BACKOFF_MAX_MS);
    }
    last().open();
    // Pings keep the idle timer away; the server answers.
    for (let i = 0; i < 3; i++) {
      await clock.advance(PING_MS);
      last().receive({ type: 'pong', at: 0 });
    }
    last().serverClose(1001, 'shutdown');
    await settle();
    const retry = states.at(-1);
    expect((retry?.retryAt ?? 0) - clock.now()).toBe(1_000);
  });

  it.each([
    [4409, 'replaced'],
    [4408, 'heartbeat timeout'],
    [1001, 'shutdown'],
    [1006, ''],
  ])('reconnects after close %i', async (code, reason) => {
    start();
    last().open();
    last().serverClose(code, reason);
    await settle();
    expect(states.at(-1)?.state).toBe('reconnecting');
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    expect(outcome).toBeNull();
  });

  it('logs revoked and never reconnects on 4401', async () => {
    start();
    last().open();
    last().serverClose(4401, 'revoked');
    await settle();
    expect(outcome).toBe('revoked');
    expect(states.at(-1)?.state).toBe('revoked');
    expect(logger.text()).toContain('revoked');
    await clock.advance(10 * BACKOFF_MAX_MS);
    expect(sockets).toHaveLength(1);
  });

  it('treats a refused upgrade as revoked when /runner/self answers 401', async () => {
    revokedAnswer = true;
    start();
    last().serverClose(1006);
    await settle();
    expect(outcome).toBe('revoked');
    await clock.advance(10 * BACKOFF_MAX_MS);
    expect(sockets).toHaveLength(1);
  });

  it('backs off when the upgrade fails and /runner/self cannot tell', async () => {
    revokedAnswer = new Error('unreachable');
    start();
    last().serverClose(1006);
    await settle();
    expect(outcome).toBeNull();
    expect(states.at(-1)?.state).toBe('reconnecting');
  });

  it('writes the rotated token before it acknowledges, and connects with it next', async () => {
    start();
    const socket = last();
    socket.open();
    const send = socket.sent;
    const push = send.push.bind(send);
    send.push = (...items) => {
      for (const item of items) order.push(String(item.type));
      return push(...items);
    };
    socket.receive({ type: 'rotate', token: NEW_TOKEN });
    expect(saved).toEqual([NEW_TOKEN]);
    expect(order).toEqual(['saved', 'rotated']);
    expect(logger.text()).not.toContain('dfr_');

    socket.serverClose(1001, 'shutdown');
    await settle();
    await clock.advance(1_000);
    expect(last().token).toBe(NEW_TOKEN);
  });

  it('does not acknowledge a rotation it could not save', () => {
    const fake = fakeSockets();
    connection = new RunnerConnection({
      server: 'https://demoflow.test',
      token: TOKEN,
      runnerId: 'runner-1',
      connect: fake.factory,
      clock,
      random: () => 0.5,
      logger,
      saveToken: () => {
        throw new Error('disk full');
      },
      isRevoked: async () => false,
      onState: () => {},
    });
    void connection.run();
    const socket = fake.sockets[0];
    socket?.open();
    socket?.receive({ type: 'rotate', token: NEW_TOKEN });
    expect(socket?.sent).toEqual([]);
    expect(logger.text()).toContain('disk full');
  });

  it('says bye on stop and finishes when the server closes', async () => {
    start();
    last().open();
    const stopped = connection.stop();
    expect(last().sent.at(-1)).toEqual({ type: 'bye', reason: 'stopped' });
    last().serverClose(1000, 'bye');
    expect(await stopped).toBe('stopped');
  });

  it('finishes 2 s after bye when the server never closes', async () => {
    start();
    last().open();
    const stopped = connection.stop();
    await clock.advance(2_000);
    expect(await stopped).toBe('stopped');
    expect(last().closed?.code).toBe(1000);
  });

  it('stops while waiting to reconnect without opening another socket', async () => {
    start();
    last().serverClose(1006);
    await settle();
    expect(await connection.stop()).toBe('stopped');
    await clock.advance(BACKOFF_MAX_MS);
    expect(sockets).toHaveLength(1);
  });
});

describe('RunnerConnection and the video relay', () => {
  function recordingRelay() {
    const relay = {
      handled: [] as Array<{
        message: Record<string, unknown>;
        sender: RelaySender;
      }>,
      closed: 0,
      handle(message: Record<string, unknown>, sender: RelaySender) {
        relay.handled.push({ message, sender });
      },
      closeAll() {
        relay.closed++;
      },
    };
    return relay;
  }

  it('routes video.open, video.ack and video.cancel to the relay', () => {
    const relay = recordingRelay();
    start(0.5, relay);
    last().open();
    for (const type of ['video.open', 'video.ack', 'video.cancel']) {
      last().receive({ type, streamId: 's' });
    }
    expect(relay.handled.map((item) => item.message.type)).toEqual([
      'video.open',
      'video.ack',
      'video.cancel',
    ]);
    expect(logger.text()).not.toMatch(/ignored/);
  });

  it('logs video.* as unknown when it has no relay, as a daemon before #192 did', () => {
    start();
    last().open();
    last().receive({ type: 'video.open', streamId: 's' });
    expect(logger.text()).toMatch(/ignored a message of type "video.open"/);
    expect(last().sent).toEqual([]);
  });

  it('sends text and binary frames on the socket the open came in on', () => {
    const relay = recordingRelay();
    start(0.5, relay);
    last().open();
    last().receive({ type: 'video.open', streamId: 's' });
    const sender = relay.handled[0]?.sender;
    if (sender === undefined) throw new Error('not routed');
    sender.send({ type: 'video.end', streamId: 's' });
    sender.sendBinary(new Uint8Array([1, 2, 3]));
    expect(last().sent).toContainEqual({ type: 'video.end', streamId: 's' });
    expect(last().binary).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('closes every stream when the socket closes, and never sends on the next socket', async () => {
    const relay = recordingRelay();
    start(0.5, relay);
    last().open();
    last().receive({ type: 'video.open', streamId: 's' });
    const sender = relay.handled[0]?.sender;
    if (sender === undefined) throw new Error('not routed');
    last().serverClose(1006);
    expect(relay.closed).toBe(1);
    await clock.advance(BACKOFF_MAX_MS);
    expect(sockets).toHaveLength(2);
    last().open();
    sender.send({ type: 'video.end', streamId: 's' });
    sender.sendBinary(new Uint8Array([1]));
    expect(last().sent.filter((m) => m.type === 'video.end')).toEqual([]);
    expect(last().binary).toEqual([]);
  });

  it('closes every stream when the daemon stops', async () => {
    const relay = recordingRelay();
    start(0.5, relay);
    last().open();
    const stopped = connection.stop();
    last().serverClose(1000, 'bye');
    expect(await stopped).toBe('stopped');
    expect(relay.closed).toBeGreaterThanOrEqual(1);
  });
});
