import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp, type TestApp } from '../test/test-app';
import {
  approve,
  MACHINE,
  type Paired,
  pair,
  poll,
  requestCode,
  type SignedIn,
  signedInUser,
} from './runner.fixtures';
import { RUNNER_LAST_USED_INTERVAL_MS } from './runner-auth.service';

const WEB_ORIGIN = 'http://localhost:3670';

describe('runners (integration)', () => {
  let t: TestApp;
  let http: App;
  let alice: SignedIn;
  let bob: SignedIn;

  beforeEach(async () => {
    t = await createTestApp();
    http = t.app.getHttpServer();
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
  });

  afterEach(async () => {
    await t.app.close();
  });

  function list(cookie: string) {
    return request(http).get('/runners').set('Cookie', cookie);
  }

  function self(token: string) {
    return request(http)
      .get('/runner/self')
      .set('Authorization', `Bearer ${token}`);
  }

  describe('the machine list', () => {
    it('lists unrevoked machines newest first, without the token hash', async () => {
      const older = await pair(http, alice, 'Older');
      t.clock.advance(60_000);
      const newer = await pair(http, alice, 'Newer');

      const res = await list(alice.cookie).expect(200);
      expect(res.body).toEqual({
        runners: [
          {
            id: newer.runnerId,
            name: 'Newer',
            os: MACHINE.os,
            cliVersion: MACHINE.cliVersion,
            createdAt: expect.any(String),
            lastUsedAt: null,
            online: false,
            features: [],
            lastSeenAt: null,
            lastSeenIp: null,
          },
          expect.objectContaining({ id: older.runnerId, name: 'Older' }),
        ],
      });
    });

    it('renames a machine and returns it', async () => {
      const paired = await pair(http, alice);
      const res = await request(http)
        .patch(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .send({ name: '  Render box ' })
        .expect(200);
      expect(res.body.runner).toEqual(
        expect.objectContaining({ id: paired.runnerId, name: 'Render box' }),
      );
      await request(http)
        .patch(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .send({ name: '' })
        .expect(400);
    });

    it('revokes a machine: gone from the list, its token refused at once', async () => {
      const paired = await pair(http, alice);
      await self(paired.token).expect(200);

      await request(http)
        .delete(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);

      expect((await list(alice.cookie).expect(200)).body.runners).toEqual([]);
      await self(paired.token).expect(401);
      await request(http)
        .delete(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(404);
    });

    it('keeps its projects and unbinds them, leaving their runs (spec #178)', async () => {
      const paired = await pair(http, alice);
      const project = await t.prisma.project.create({
        data: {
          userId: alice.user.id,
          name: 'Shop',
          runnerId: paired.runnerId,
          rootPath: '/home/alice/shop',
          runs: {
            create: {
              runnerId: paired.runnerId,
              scenarioName: 'checkout',
              scenarioPath: 'checkout.yaml',
              status: 'passed',
              startedAt: t.clock.now(),
              durationMs: 1000,
              formats: ['mp4'],
              cliVersion: MACHINE.cliVersion,
            },
          },
        },
      });

      await request(http)
        .delete(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);

      expect(
        await t.prisma.project.findUniqueOrThrow({ where: { id: project.id } }),
      ).toEqual(
        expect.objectContaining({
          runnerId: null,
          rootPath: '/home/alice/shop',
        }),
      );
      expect(
        await t.prisma.run.findMany({ where: { projectId: project.id } }),
      ).toEqual([expect.objectContaining({ runnerId: paired.runnerId })]);
    });

    it('requires a session', async () => {
      await request(http).get('/runners').expect(401);
    });

    it('refuses a state change from another origin', async () => {
      const paired = await pair(http, alice);
      await request(http)
        .delete(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await request(http)
        .delete(`/runners/${paired.runnerId}`)
        .set('Cookie', alice.cookie)
        .set('Origin', WEB_ORIGIN)
        .expect(204);
    });
  });

  describe('authorization across accounts', () => {
    let alicesMachine: Paired;

    beforeEach(async () => {
      alicesMachine = await pair(http, alice, 'Alice laptop');
    });

    it("never lists another account's machines", async () => {
      await pair(http, bob, 'Bob desktop');
      const res = await list(bob.cookie).expect(200);
      expect(res.body.runners.map((r: { name: string }) => r.name)).toEqual([
        'Bob desktop',
      ]);
    });

    it("404s a rename or revoke of another account's machine", async () => {
      await request(http)
        .patch(`/runners/${alicesMachine.runnerId}`)
        .set('Cookie', bob.cookie)
        .send({ name: 'Mine now' })
        .expect(404);
      await request(http)
        .delete(`/runners/${alicesMachine.runnerId}`)
        .set('Cookie', bob.cookie)
        .expect(404);

      const row = await t.prisma.runner.findUniqueOrThrow({
        where: { id: alicesMachine.runnerId },
      });
      expect(row).toEqual(
        expect.objectContaining({ name: 'Alice laptop', revokedAt: null }),
      );
      await self(alicesMachine.token).expect(200);
    });

    it('answers a foreign id exactly like an unknown one', async () => {
      const foreign = await request(http)
        .delete(`/runners/${alicesMachine.runnerId}`)
        .set('Cookie', bob.cookie)
        .expect(404);
      const unknown = await request(http)
        .delete('/runners/00000000-0000-4000-8000-000000000000')
        .set('Cookie', bob.cookie)
        .expect(404);
      expect(foreign.body).toEqual(unknown.body);
    });

    it('binds an approval to the approver, never to a user in the body', async () => {
      const code = await requestCode(http);
      await request(http)
        .post(`/runner/device/${code.userCode}/approve`)
        .set('Cookie', bob.cookie)
        .send({ name: 'Sneaky', userId: alice.user.id })
        .expect(400);

      await approve(http, bob.cookie, code.userCode, 'Bob laptop').expect(204);
      const issued = await poll(http, code.deviceCode).expect(200);
      expect(issued.body.email).toBe(bob.user.email);

      const runner = await t.prisma.runner.findUniqueOrThrow({
        where: { id: issued.body.runnerId },
      });
      expect(runner.userId).toBe(bob.user.id);
      expect((await list(alice.cookie).expect(200)).body.runners).toHaveLength(
        1,
      );
    });
  });

  describe('the runner token', () => {
    it('answers /runner/self with the machine and account', async () => {
      const paired = await pair(http, alice, 'Studio');
      const res = await self(paired.token).expect(200);
      expect(res.body).toEqual({
        runnerId: paired.runnerId,
        name: 'Studio',
        email: alice.user.email,
      });
    });

    it('refuses a missing, malformed or unknown token', async () => {
      await request(http).get('/runner/self').expect(401);
      await self('not-a-token').expect(401);
      await self(`dfr_${'A'.repeat(43)}`).expect(401);
      // A session cookie is not a runner token.
      await request(http)
        .get('/runner/self')
        .set('Cookie', alice.cookie)
        .expect(401);
    });

    it('logs out: the token is revoked and the machine leaves the list', async () => {
      const paired = await pair(http, alice);
      await request(http)
        .post('/runner/logout')
        .set('Authorization', `Bearer ${paired.token}`)
        .expect(204);
      await self(paired.token).expect(401);
      expect((await list(alice.cookie).expect(200)).body.runners).toEqual([]);
    });

    it('records lastUsedAt at most once a minute', async () => {
      const paired = await pair(http, alice);
      const lastUsed = async () =>
        (
          await t.prisma.runner.findUniqueOrThrow({
            where: { id: paired.runnerId },
          })
        ).lastUsedAt;

      const first = t.clock.now();
      await self(paired.token).expect(200);
      expect(await lastUsed()).toEqual(first);

      t.clock.advance(RUNNER_LAST_USED_INTERVAL_MS - 1);
      await self(paired.token).expect(200);
      expect(await lastUsed()).toEqual(first);

      t.clock.advance(1);
      await self(paired.token).expect(200);
      expect(await lastUsed()).toEqual(t.clock.now());
    });
  });
});
