import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { hashToken } from '../auth/tokens';
import { createTestApp, type TestApp } from '../test/test-app';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from './runner.fixtures';
import {
  PENDING_TOKEN_TTL_MS,
  TOKEN_ROTATION_AGE_MS,
} from './runner-auth.service';
import { RunnerConnections } from './runner-connections.service';
import {
  CLOSE_GOING_AWAY,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  IDLE_TIMEOUT_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  PING_INTERVAL_MS,
} from './runner-socket';
import {
  eventually,
  TestSocket,
  upgradeStatus,
} from './runner-socket.fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('runner socket (integration)', () => {
  let t: TestApp;
  let http: App;
  let url: string;
  let connections: RunnerConnections;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  let closed: boolean;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    closed = false;
    http = t.app.getHttpServer();
    const { port } = http.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/runner`;
    connections = t.app.get(RunnerConnections);
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    if (!closed) {
      await t.app.close();
    }
  });

  async function connect(
    token = machine.token,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, token, headers);
    sockets.push(socket);
    return socket;
  }

  function list(cookie: string) {
    return request(http).get('/runners').set('Cookie', cookie).expect(200);
  }

  function self(token: string) {
    return request(http)
      .get('/runner/self')
      .set('Authorization', `Bearer ${token}`);
  }

  function row() {
    return t.prisma.runner.findUniqueOrThrow({
      where: { id: machine.runnerId },
    });
  }

  /** The token of the next `rotate`. */
  async function rotation(socket: TestSocket): Promise<string> {
    const { token } = await socket.next('rotate');
    if (typeof token !== 'string') {
      throw new Error('rotate carries no token');
    }
    return token;
  }

  async function ageToken(ms: number): Promise<void> {
    await t.prisma.runner.update({
      where: { id: machine.runnerId },
      data: { tokenIssuedAt: new Date(t.clock.now().getTime() - ms) },
    });
  }

  describe('authentication on the upgrade', () => {
    it.each([
      ['no header', {}],
      ['a session-shaped token', { Authorization: 'Bearer not-a-runner' }],
      ['an unknown token', { Authorization: 'Bearer dfr_unknown' }],
      ['another scheme', { Authorization: `Basic ${'dfr_x'}` }],
    ])('answers 401 to %s, and no socket opens', async (_label, headers) => {
      await expect(upgradeStatus(url, headers)).resolves.toBe(401);
      expect(connections.isOnline(machine.runnerId)).toBe(false);
    });

    it('answers 401 to a revoked token', async () => {
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      await expect(
        upgradeStatus(url, { Authorization: `Bearer ${machine.token}` }),
      ).resolves.toBe(401);
      expect(connections.isOnline(machine.runnerId)).toBe(false);
    });

    it("binds each socket to its token's machine, and greets it", async () => {
      const bobMachine = await pair(http, bob, 'Bob box');
      const socket = await connect();
      const bobSocket = await connect(bobMachine.token);

      expect(socket.hello).toEqual({
        type: 'hello',
        runnerId: machine.runnerId,
        serverTime: t.clock.now().toISOString(),
      });
      expect(bobSocket.hello?.runnerId).toBe(bobMachine.runnerId);

      // Bob closing his machine's socket leaves Alice's up.
      await bobSocket.close();
      await eventually(() => !connections.isOnline(bobMachine.runnerId));
      expect(connections.isOnline(machine.runnerId)).toBe(true);
      const bobs = (await list(bob.cookie)).body.runners;
      expect(bobs.map((r: { id: string }) => r.id)).toEqual([
        bobMachine.runnerId,
      ]);
    });
  });

  describe('online state and last seen', () => {
    it('shows the owner online, last seen and the address', async () => {
      await connect();
      const res = await list(alice.cookie);
      expect(res.body.runners).toEqual([
        expect.objectContaining({
          id: machine.runnerId,
          online: true,
          lastSeenAt: t.clock.now().toISOString(),
          lastSeenIp: '127.0.0.1',
        }),
      ]);
    });

    it('never shows one account the online state or address of another', async () => {
      await connect();
      const res = await list(bob.cookie);
      expect(res.body).toEqual({ runners: [] });
      expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    });

    it('takes the address from a trusted proxy, as req.ip does (#120)', async () => {
      await connect(machine.token, { 'X-Forwarded-For': '203.0.113.7' });
      expect((await row()).lastSeenIp).toBe('203.0.113.7');
    });

    it('writes last seen at most once a minute', async () => {
      const socket = await connect();
      const start = t.clock.now();

      t.clock.advance(LAST_SEEN_WRITE_INTERVAL_MS - 1000);
      await socket.roundTrip();
      await socket.roundTrip();
      expect((await row()).lastSeenAt).toEqual(start);

      t.clock.advance(1000);
      await socket.roundTrip();
      const later = t.clock.now();
      await eventually(
        async () => (await row()).lastSeenAt?.getTime() === later.getTime(),
      );
    });

    it('goes offline when the daemon closes, keeping the last message time', async () => {
      const socket = await connect();
      t.clock.advance(10_000);
      await socket.roundTrip();
      const lastMessage = t.clock.now();
      await socket.close();

      await eventually(() => !connections.isOnline(machine.runnerId));
      await eventually(
        async () =>
          (await row()).lastSeenAt?.getTime() === lastMessage.getTime(),
      );
      const res = await list(alice.cookie);
      expect(res.body.runners[0]).toEqual(
        expect.objectContaining({ online: false, lastSeenIp: '127.0.0.1' }),
      );
    });
  });

  describe('heartbeats', () => {
    it('pings every 25 s', async () => {
      const socket = await connect();
      t.clock.advance(PING_INTERVAL_MS - 1);
      connections.tick();
      t.clock.advance(1);
      connections.tick();
      const ping = await socket.next('ping');
      expect(ping).toEqual({ type: 'ping', at: t.clock.now().getTime() });
      expect(socket.received.filter((m) => m.type === 'ping')).toHaveLength(0);
    });

    it('answers a ping with a pong carrying the same time', async () => {
      const socket = await connect();
      socket.send({ type: 'ping', at: 1234 });
      await expect(socket.next('pong')).resolves.toEqual({
        type: 'pong',
        at: 1234,
      });
    });

    it('closes a silent daemon after 60 s and marks it offline', async () => {
      const socket = await connect();
      t.clock.advance(IDLE_TIMEOUT_MS - 1);
      connections.tick();
      expect(connections.isOnline(machine.runnerId)).toBe(true);

      t.clock.advance(1);
      connections.tick();
      expect(connections.isOnline(machine.runnerId)).toBe(false);
      await expect(socket.closed).resolves.toEqual({
        code: CLOSE_HEARTBEAT_TIMEOUT,
        reason: 'heartbeat timeout',
      });
      expect((await list(alice.cookie)).body.runners[0].online).toBe(false);
    });

    it('keeps a daemon that answers', async () => {
      const socket = await connect();
      t.clock.advance(PING_INTERVAL_MS);
      connections.tick();
      const ping = await socket.next('ping');
      socket.send({ type: 'pong', at: ping.at });
      await socket.roundTrip();

      t.clock.advance(IDLE_TIMEOUT_MS - 1);
      connections.tick();
      expect(connections.isOnline(machine.runnerId)).toBe(true);
    });

    it('ignores frames it cannot read, and stays open', async () => {
      const socket = await connect();
      socket.sendRaw('not json');
      socket.sendRaw(Buffer.from([1, 2, 3]));
      socket.send(['ping']);
      socket.send({ type: 'teleport', to: 'mars' });
      socket.send({ type: 'ping', at: 'soon' });
      socket.send({ type: '__proto__' });
      await socket.roundTrip(7);
      expect(connections.isOnline(machine.runnerId)).toBe(true);
    });
  });

  describe('one socket per machine', () => {
    it('closes the older socket with 4409 when the same token connects again', async () => {
      const first = await connect();
      const second = await connect();
      await expect(first.closed).resolves.toEqual({
        code: CLOSE_REPLACED,
        reason: 'replaced',
      });
      expect(connections.isOnline(machine.runnerId)).toBe(true);
      await second.roundTrip();
    });
  });

  describe('revocation', () => {
    it('closes the socket with 4401 when the owner revokes the machine', async () => {
      const socket = await connect();
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      await expect(socket.closed).resolves.toEqual({
        code: CLOSE_REVOKED,
        reason: 'revoked',
      });
      expect(connections.isOnline(machine.runnerId)).toBe(false);
      const revoked = await row();
      expect(revoked.lastSeenAt).toBeNull();
      expect(revoked.lastSeenIp).toBeNull();
    });

    it('closes the socket with 4401 on runner logout', async () => {
      const socket = await connect();
      await request(http)
        .post('/runner/logout')
        .set('Authorization', `Bearer ${machine.token}`)
        .expect(204);
      await expect(socket.closed).resolves.toEqual({
        code: CLOSE_REVOKED,
        reason: 'revoked',
      });
    });

    it("leaves another account's socket alone when a foreign id is revoked", async () => {
      const socket = await connect();
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', bob.cookie)
        .expect(404);
      await socket.roundTrip();
      expect(connections.isOnline(machine.runnerId)).toBe(true);
    });
  });

  describe('rotation', () => {
    it('does not rotate a token younger than 30 days', async () => {
      await ageToken(TOKEN_ROTATION_AGE_MS - 1000);
      const socket = await connect();
      await socket.roundTrip();
      expect(socket.received.some((m) => m.type === 'rotate')).toBe(false);
      expect((await row()).pendingTokenHash).toBeNull();
    });

    it('rotates a 30-day-old token; the old one works until rotated', async () => {
      await ageToken(TOKEN_ROTATION_AGE_MS);
      const socket = await connect();
      const token = await rotation(socket);
      expect(token).toMatch(/^dfr_/);
      expect(token).not.toBe(machine.token);
      await self(machine.token).expect(200);

      socket.send({ type: 'rotated' });
      await eventually(async () => (await row()).pendingTokenHash === null);

      const rotated = await row();
      expect(rotated.tokenHash).toBe(hashToken(token));
      expect(rotated.tokenIssuedAt).toEqual(t.clock.now());
      await self(machine.token).expect(401);
      await expect(
        upgradeStatus(url, { Authorization: `Bearer ${machine.token}` }),
      ).resolves.toBe(401);
      await self(token).expect(200);
      // The socket that rotated stays up.
      await socket.roundTrip();
    });

    it('without an ack keeps the old token past 24 h and clears the pending one', async () => {
      await ageToken(TOKEN_ROTATION_AGE_MS);
      const socket = await connect();
      const lost = await rotation(socket);
      await socket.close();

      t.clock.advance(PENDING_TOKEN_TTL_MS);
      await self(lost).expect(401);
      await self(machine.token).expect(200);
      expect((await row()).pendingTokenHash).toBeNull();

      // The next connect retries with a new token.
      const again = await connect();
      const retry = await rotation(again);
      expect(retry).not.toBe(lost);
    });

    it('lets the daemon reconnect with the new token when its ack was lost', async () => {
      await ageToken(TOKEN_ROTATION_AGE_MS);
      const socket = await connect();
      const token = await rotation(socket);
      await socket.close();

      t.clock.advance(DAY_MS - 1000);
      const resumed = await connect(token);
      await resumed.roundTrip();
      expect(resumed.received.some((m) => m.type === 'rotate')).toBe(false);
      expect((await row()).tokenHash).toBe(hashToken(token));
      await self(machine.token).expect(401);
    });

    it('ignores rotated when no rotation is in flight', async () => {
      const socket = await connect();
      socket.send({ type: 'rotated' });
      await socket.roundTrip();
      await self(machine.token).expect(200);
    });
  });

  describe('shutdown', () => {
    it('says bye and closes with 1001, so daemons reconnect', async () => {
      const socket = await connect();
      closed = true;
      await t.app.close();
      await expect(socket.closed).resolves.toEqual({
        code: CLOSE_GOING_AWAY,
        reason: 'shutdown',
      });
      expect(socket.received).toContainEqual({
        type: 'bye',
        reason: 'shutdown',
      });
    });
  });
});
