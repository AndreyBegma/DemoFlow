import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SESSION_COOKIE } from '../auth/session-cookie';
import {
  approve,
  type Paired,
  pair,
  requestCode,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { RunnerConnections } from '../runner/runner-connections.service';
import { CLOSE_REVOKED } from '../runner/runner-socket';
import { TestSocket, upgradeStatus } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { CONFIRMATION_MISMATCH } from './account.service';

describe('account deletion (integration)', () => {
  let t: TestApp;
  let http: App;
  let url: string;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    const { port } = http.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/runner`;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function connect(token = machine.token): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, token);
    sockets.push(socket);
    return socket;
  }

  function deleteAccount(cookie: string, email: string) {
    return request(http).delete('/me').set('Cookie', cookie).send({ email });
  }

  function me(cookie: string) {
    return request(http).get('/auth/me').set('Cookie', cookie);
  }

  /** A code `owner` approved and nobody polled yet: the row stays. */
  async function approvedCode(owner: SignedIn): Promise<string> {
    const code = await requestCode(http);
    await approve(http, owner.cookie, code.userCode).expect(204);
    return code.userCode.replace('-', '');
  }

  /** Every row hanging off `userId`. */
  async function rowsOf(userId: string) {
    const [users, sessions, emailTokens, identities, runners, deviceCodes] =
      await Promise.all([
        t.prisma.user.count({ where: { id: userId } }),
        t.prisma.session.count({ where: { userId } }),
        t.prisma.emailToken.count({ where: { userId } }),
        t.prisma.githubIdentity.count({ where: { userId } }),
        t.prisma.runner.count({ where: { userId } }),
        t.prisma.deviceCode.count({ where: { approvedById: userId } }),
      ]);
    return { users, sessions, emailTokens, identities, runners, deviceCodes };
  }

  /** One row of each kind, beyond the session and the paired machine. */
  async function extraRows(user: SignedIn): Promise<void> {
    await t.prisma.emailToken.create({
      data: {
        userId: user.user.id,
        tokenHash: `hash-${user.user.id}`,
        purpose: 'VERIFY_EMAIL',
        expiresAt: new Date(t.clock.now().getTime() + 60_000),
      },
    });
    await t.prisma.githubIdentity.create({
      data: {
        userId: user.user.id,
        githubUserId: `gh-${user.user.id}`,
        login: 'octo',
      },
    });
    await approvedCode(user);
  }

  it('answers 401 without a session', async () => {
    await request(http)
      .delete('/me')
      .send({ email: alice.user.email })
      .expect(401);
  });

  it('deletes nothing when the email does not match', async () => {
    await extraRows(alice);
    const before = await rowsOf(alice.user.id);

    const res = await deleteAccount(alice.cookie, bob.user.email).expect(400);
    expect(res.body).toEqual({ error: CONFIRMATION_MISMATCH });
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(await rowsOf(alice.user.id)).toEqual(before);
    await me(alice.cookie).expect(200);
  });

  it('rejects a body without an email', async () => {
    await request(http)
      .delete('/me')
      .set('Cookie', alice.cookie)
      .send({})
      .expect(400);
    expect((await rowsOf(alice.user.id)).users).toBe(1);
  });

  it('deletes the user and every cascaded row on a match, in any case', async () => {
    await extraRows(alice);
    await extraRows(bob);
    const bobBefore = await rowsOf(bob.user.id);

    const typed = `  ${alice.user.email.toUpperCase()} `;
    const res = await deleteAccount(alice.cookie, typed).expect(204);

    const cleared = (
      res.headers['set-cookie'] as unknown as string[] | undefined
    )?.find((header) => header.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(await rowsOf(alice.user.id)).toEqual({
      users: 0,
      sessions: 0,
      emailTokens: 0,
      identities: 0,
      runners: 0,
      deviceCodes: 0,
    });
    expect(await rowsOf(bob.user.id)).toEqual(bobBefore);
  });

  it('rejects the old session cookie afterwards', async () => {
    await deleteAccount(alice.cookie, alice.user.email).expect(204);
    await me(alice.cookie).expect(401);
    await deleteAccount(alice.cookie, alice.user.email).expect(401);
  });

  it('says bye revoked to a live socket and closes it with 4401', async () => {
    const socket = await connect();
    const bobMachine = await pair(http, bob, 'Bob box');
    const bobSocket = await connect(bobMachine.token);

    await deleteAccount(alice.cookie, alice.user.email).expect(204);

    await expect(socket.next('bye')).resolves.toEqual({
      type: 'bye',
      reason: 'revoked',
    });
    await expect(socket.closed).resolves.toEqual({
      code: CLOSE_REVOKED,
      reason: 'revoked',
    });
    const connections = t.app.get(RunnerConnections);
    expect(connections.isOnline(machine.runnerId)).toBe(false);
    expect(connections.isOnline(bobMachine.runnerId)).toBe(true);
    await bobSocket.roundTrip();
  });

  it("rejects the deleted machine's token on reconnect", async () => {
    await deleteAccount(alice.cookie, alice.user.email).expect(204);
    await expect(
      upgradeStatus(url, { Authorization: `Bearer ${machine.token}` }),
    ).resolves.toBe(401);
    await request(http)
      .get('/runner/self')
      .set('Authorization', `Bearer ${machine.token}`)
      .expect(401);
  });

  it('removes the device codes the user approved, and only those', async () => {
    const mine = await approvedCode(alice);
    const theirs = await approvedCode(bob);

    await deleteAccount(alice.cookie, alice.user.email).expect(204);

    await expect(
      t.prisma.deviceCode.findUnique({ where: { userCode: mine } }),
    ).resolves.toBeNull();
    await expect(
      t.prisma.deviceCode.findUnique({ where: { userCode: theirs } }),
    ).resolves.not.toBeNull();
  });
});
