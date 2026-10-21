import request from 'supertest';
import type { App } from 'supertest/types';
import { hashToken } from '../auth/tokens';
import { createTestApp, type TestApp } from '../test/test-app';
import {
  DEVICE_CODE_TTL_MS,
  POLL_INTERVAL_S,
  RUNNER_LIMIT,
} from './device-code.service';
import {
  approve,
  insertRunners,
  MACHINE,
  poll,
  requestCode,
  type SignedIn,
  signedInUser,
} from './runner.fixtures';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const POLL_MS = POLL_INTERVAL_S * 1000;

describe('runner device-code flow (integration)', () => {
  let t: TestApp;
  let http: App;

  beforeEach(async () => {
    t = await createTestApp();
    http = t.app.getHttpServer();
  });

  afterEach(async () => {
    await t.app.close();
  });

  describe('POST /runner/device/code', () => {
    it('answers the RFC 8628 shape with an unambiguous user code', async () => {
      const code = await requestCode(http);
      expect(code).toEqual({
        deviceCode: expect.any(String),
        userCode: expect.stringMatching(
          /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
        ),
        verificationUri: 'http://localhost:3670/app/device',
        verificationUriComplete: `http://localhost:3670/app/device?code=${code.userCode}`,
        expiresIn: 600,
        interval: 5,
      });
    });

    it('refuses a body without machine info, or with extra fields', async () => {
      await request(http)
        .post('/runner/device/code')
        .send({ hostname: 'x' })
        .expect(400);
      await request(http)
        .post('/runner/device/code')
        .send({ ...MACHINE, path: '/home/me' })
        .expect(400);
    });
  });

  describe('POST /runner/device/token — every state', () => {
    let owner: SignedIn;

    beforeEach(async () => {
      owner = await signedInUser(t, 'poll');
    });

    it('is pending until approved, then issues a dfr_ token once', async () => {
      const code = await requestCode(http);
      const pending = await poll(http, code.deviceCode).expect(400);
      expect(pending.body).toEqual({ error: 'authorization_pending' });

      await approve(http, owner.cookie, code.userCode, 'Studio').expect(204);
      t.clock.advance(POLL_MS);
      const issued = await poll(http, code.deviceCode).expect(200);
      expect(issued.body).toEqual({
        token: expect.stringMatching(/^dfr_[A-Za-z0-9_-]{43}$/),
        runnerId: expect.any(String),
        name: 'Studio',
        email: owner.user.email,
      });

      t.clock.advance(POLL_MS);
      const again = await poll(http, code.deviceCode).expect(400);
      expect(again.body).toEqual({ error: 'expired_token' });
      expect(
        await t.prisma.runner.count({ where: { userId: owner.user.id } }),
      ).toBe(1);
    });

    it('answers slow_down when polled within 5 s', async () => {
      const code = await requestCode(http);
      await poll(http, code.deviceCode).expect(400);
      t.clock.advance(POLL_MS - 1);
      const fast = await poll(http, code.deviceCode).expect(400);
      expect(fast.body).toEqual({ error: 'slow_down' });
      t.clock.advance(POLL_MS);
      const slow = await poll(http, code.deviceCode).expect(400);
      expect(slow.body).toEqual({ error: 'authorization_pending' });
    });

    it('answers access_denied after a deny', async () => {
      const code = await requestCode(http);
      await request(http)
        .post(`/runner/device/${code.userCode}/deny`)
        .set('Cookie', owner.cookie)
        .expect(204);
      const denied = await poll(http, code.deviceCode).expect(400);
      expect(denied.body).toEqual({ error: 'access_denied' });
      // The denied code is gone; it cannot be approved afterwards.
      await approve(http, owner.cookie, code.userCode).expect(404);
    });

    it('answers expired_token after 10 minutes, even when approved', async () => {
      const code = await requestCode(http);
      await approve(http, owner.cookie, code.userCode).expect(204);
      t.clock.advance(DEVICE_CODE_TTL_MS);
      const expired = await poll(http, code.deviceCode).expect(400);
      expect(expired.body).toEqual({ error: 'expired_token' });
      expect(
        await t.prisma.runner.count({ where: { userId: owner.user.id } }),
      ).toBe(0);
    });

    it('answers expired_token for an unknown device code', async () => {
      const res = await poll(http, 'not-a-device-code').expect(400);
      expect(res.body).toEqual({ error: 'expired_token' });
    });

    it('never issues two tokens to concurrent polls', async () => {
      const code = await requestCode(http);
      await approve(http, owner.cookie, code.userCode).expect(204);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => poll(http, code.deviceCode)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        await t.prisma.runner.count({ where: { userId: owner.user.id } }),
      ).toBe(1);
    });
  });

  describe('approval page endpoints', () => {
    it('describes a code to a signed-in user, with or without the dash', async () => {
      const viewer = await signedInUser(t, 'describe', false);
      const code = await requestCode(http);
      for (const typed of [code.userCode, code.userCode.replace('-', '')]) {
        const res = await request(http)
          .get(`/runner/device/${typed.toLowerCase()}`)
          .set('Cookie', viewer.cookie)
          .expect(200);
        expect(res.body).toEqual({
          userCode: code.userCode,
          hostname: MACHINE.hostname,
          os: MACHINE.os,
          cliVersion: MACHINE.cliVersion,
          createdAt: expect.any(String),
        });
      }
    });

    it('404s an unknown, expired or used code, and 401s a guest', async () => {
      const viewer = await signedInUser(t, 'describe404');
      const describe = (userCode: string) =>
        request(http)
          .get(`/runner/device/${userCode}`)
          .set('Cookie', viewer.cookie);

      await describe('ABCD-2345').expect(404);
      await describe('nonsense').expect(404);

      const code = await requestCode(http);
      await request(http).get(`/runner/device/${code.userCode}`).expect(401);
      await approve(http, viewer.cookie, code.userCode).expect(204);
      await describe(code.userCode).expect(404);
      await approve(http, viewer.cookie, code.userCode).expect(404);

      const late = await requestCode(http);
      t.clock.advance(DEVICE_CODE_TTL_MS);
      await describe(late.userCode).expect(404);
    });

    it('gives an unverified user 403 on approve and deny', async () => {
      const unverified = await signedInUser(t, 'unverified', false);
      const code = await requestCode(http);
      await approve(http, unverified.cookie, code.userCode).expect(403);
      await request(http)
        .post(`/runner/device/${code.userCode}/deny`)
        .set('Cookie', unverified.cookie)
        .expect(403);
      const res = await poll(http, code.deviceCode).expect(400);
      expect(res.body).toEqual({ error: 'authorization_pending' });
    });

    it('validates the machine name: trimmed, 1–64 characters', async () => {
      const owner = await signedInUser(t, 'name');
      const code = await requestCode(http);
      await approve(http, owner.cookie, code.userCode, '   ').expect(400);
      await approve(http, owner.cookie, code.userCode, 'x'.repeat(65)).expect(
        400,
      );
      await approve(http, owner.cookie, code.userCode, '  Desk  ').expect(204);
      const res = await poll(http, code.deviceCode).expect(200);
      expect(res.body.name).toBe('Desk');
    });
  });

  describe('the 20-machine limit', () => {
    it('answers 409 runner_limit for a 21st machine, and works after a revoke', async () => {
      const owner = await signedInUser(t, 'limit');
      const ids = await insertRunners(t, owner.user.id, RUNNER_LIMIT);

      const code = await requestCode(http);
      const refused = await approve(http, owner.cookie, code.userCode).expect(
        409,
      );
      expect(refused.body.error).toBe('runner_limit');

      await request(http)
        .delete(`/runners/${ids[0]}`)
        .set('Cookie', owner.cookie)
        .expect(204);
      await approve(http, owner.cookie, code.userCode).expect(204);
      await poll(http, code.deviceCode).expect(200);
    });

    it('counts approved codes not yet redeemed', async () => {
      const owner = await signedInUser(t, 'limit-pending');
      await insertRunners(t, owner.user.id, RUNNER_LIMIT - 1);

      const first = await requestCode(http);
      const second = await requestCode(http);
      await approve(http, owner.cookie, first.userCode).expect(204);
      const res = await approve(http, owner.cookie, second.userCode).expect(
        409,
      );
      expect(res.body.error).toBe('runner_limit');
    });

    it('holds under concurrent approvals', async () => {
      const owner = await signedInUser(t, 'limit-race');
      await insertRunners(t, owner.user.id, RUNNER_LIMIT - 1);
      const codes = await Promise.all([
        requestCode(http),
        requestCode(http),
        requestCode(http),
      ]);
      const results = await Promise.all(
        codes.map((c) => approve(http, owner.cookie, c.userCode)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409]);
    });
  });

  it('stores no plaintext token or device code', async () => {
    const owner = await signedInUser(t, 'plaintext');
    const pendingCode = await requestCode(http);
    const pairedCode = await requestCode(http);
    await approve(http, owner.cookie, pairedCode.userCode).expect(204);
    const issued = await poll(http, pairedCode.deviceCode).expect(200);
    const token: string = issued.body.token;

    const runners = await t.prisma.runner.findMany({
      where: { userId: owner.user.id },
    });
    const codes = await t.prisma.deviceCode.findMany();
    expect(runners).toHaveLength(1);
    expect(codes.length).toBeGreaterThan(0);

    for (const runner of runners) {
      expect(runner.tokenHash).toMatch(SHA256_HEX);
      expect(runner.tokenHash).toBe(hashToken(token));
    }
    for (const row of codes) {
      expect(row.deviceCodeHash).toMatch(SHA256_HEX);
    }
    expect(codes.map((c) => c.deviceCodeHash)).toContain(
      hashToken(pendingCode.deviceCode),
    );

    const stored = JSON.stringify({ runners, codes });
    for (const secret of [
      token,
      token.slice('dfr_'.length),
      pendingCode.deviceCode,
      pairedCode.deviceCode,
    ]) {
      expect(stored).not.toContain(secret);
    }
  });
});
