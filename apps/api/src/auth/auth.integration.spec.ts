import { Controller, Get, UseGuards } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  createTestApp,
  type TestApp,
  tokenFromLink,
  uniqueEmail,
} from '../test/test-app';
import { SessionGuard } from './session.guard';
import { SESSION_SLIDE_INTERVAL_MS, SESSION_TTL_MS } from './session.service';
import { SESSION_COOKIE } from './session-cookie';
import { hashToken } from './tokens';
import { VerifiedGuard } from './verified.guard';

const PASSWORD = 'correct horse battery';
const OTHER_PASSWORD = 'another long passphrase';
const WEB_ORIGIN = 'http://localhost:3670';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A route behind both guards, mounted only here. */
@Controller('test-verified')
@UseGuards(SessionGuard, VerifiedGuard)
class VerifiedProbeController {
  @Get()
  probe(): { ok: true } {
    return { ok: true };
  }
}

describe('auth (integration)', () => {
  let t: TestApp;
  let http: App;

  beforeEach(async () => {
    t = await createTestApp([VerifiedProbeController]);
    http = t.app.getHttpServer();
  });

  afterEach(async () => {
    await t.app.close();
  });

  function signUp(email: string, password = PASSWORD) {
    return request(http).post('/auth/sign-up').send({ email, password });
  }

  function signInRaw(email: string, password = PASSWORD) {
    return request(http).post('/auth/sign-in').send({ email, password });
  }

  /** The `df_session=<token>` pair to send back as a Cookie header. */
  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const res = await signInRaw(email, password).expect(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  function me(cookie: string) {
    return request(http).get('/auth/me').set('Cookie', cookie);
  }

  function lastLink(email: string): string {
    const sent = t.mailer.to(email);
    return tokenFromLink(sent[sent.length - 1]?.link);
  }

  async function verifiedUser(email: string): Promise<string> {
    await signUp(email).expect(202);
    await request(http)
      .post('/auth/verify-email')
      .send({ token: lastLink(email) })
      .expect(204);
    return signIn(email);
  }

  describe('sign-up and verification', () => {
    it('signs up, verifies through the emailed link, and me shows it', async () => {
      const email = uniqueEmail('flow');
      const res = await signUp(email).expect(202);
      expect(res.body).toEqual({});

      const [message] = t.mailer.to(email);
      expect(message.subject).toBe('Verify your DemoFlow email');
      expect(message.link).toMatch(
        /^http:\/\/localhost:3670\/verify-email\?token=/,
      );

      const cookie = await signIn(email);
      expect((await me(cookie).expect(200)).body.user).toEqual({
        id: expect.any(String),
        email,
        emailVerified: false,
      });

      await request(http)
        .post('/auth/verify-email')
        .send({ token: tokenFromLink(message.link) })
        .expect(204);
      expect((await me(cookie).expect(200)).body.user.emailVerified).toBe(true);
    });

    it('stores the email trimmed and lower-cased', async () => {
      const email = uniqueEmail('case');
      await signUp(`  ${email.toUpperCase()} `).expect(202);
      expect(
        await t.prisma.user.findUnique({ where: { email } }),
      ).not.toBeNull();
      await signIn(email.toUpperCase());
    });

    it('answers an existing email with the same 202, and sends a notice instead', async () => {
      const email = uniqueEmail('dup');
      const first = await signUp(email).expect(202);
      const second = await signUp(email, OTHER_PASSWORD).expect(202);

      expect(second.body).toEqual(first.body);
      const sent = t.mailer.to(email);
      expect(sent.map((m) => m.subject)).toEqual([
        'Verify your DemoFlow email',
        'Someone tried to sign up with your email',
      ]);
      expect(sent[1].link).toBeUndefined();
      expect(await t.prisma.user.count({ where: { email } })).toBe(1);
      await signIn(email);
      await signInRaw(email, OTHER_PASSWORD).expect(401);
    });

    it('rejects a password shorter than 10 or longer than 128 characters', async () => {
      await signUp(uniqueEmail('short'), 'x'.repeat(9)).expect(400);
      await signUp(uniqueEmail('long'), 'x'.repeat(129)).expect(400);
      await signUp(uniqueEmail('max'), 'x'.repeat(128)).expect(202);
    });

    it('refuses a verification link that is used or older than 24 hours', async () => {
      const used = uniqueEmail('used');
      await signUp(used).expect(202);
      const token = lastLink(used);
      await request(http)
        .post('/auth/verify-email')
        .send({ token })
        .expect(204);
      await request(http)
        .post('/auth/verify-email')
        .send({ token })
        .expect(400);

      const late = uniqueEmail('late');
      await signUp(late).expect(202);
      t.clock.advance(DAY_MS + 1000);
      await request(http)
        .post('/auth/verify-email')
        .send({ token: lastLink(late) })
        .expect(400);
      const user = await t.prisma.user.findUniqueOrThrow({
        where: { email: late },
      });
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('refuses an unknown token, and a reset token used to verify', async () => {
      await request(http)
        .post('/auth/verify-email')
        .send({ token: 'not-a-token' })
        .expect(400);

      const email = uniqueEmail('purpose');
      await signUp(email).expect(202);
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      await request(http)
        .post('/auth/verify-email')
        .send({ token: lastLink(email) })
        .expect(400);
    });

    it('resends the verification link, which replaces the earlier one', async () => {
      const email = uniqueEmail('resend');
      await signUp(email).expect(202);
      const first = lastLink(email);
      const cookie = await signIn(email);

      await request(http)
        .post('/auth/verify-email/resend')
        .set('Cookie', cookie)
        .expect(202);
      const second = lastLink(email);
      expect(second).not.toBe(first);

      await request(http)
        .post('/auth/verify-email')
        .send({ token: first })
        .expect(400);
      await request(http)
        .post('/auth/verify-email')
        .send({ token: second })
        .expect(204);

      // Verified: resend sends nothing.
      const count = t.mailer.to(email).length;
      await request(http)
        .post('/auth/verify-email/resend')
        .set('Cookie', cookie)
        .expect(202);
      expect(t.mailer.to(email)).toHaveLength(count);
    });

    it('needs a session to resend', async () => {
      await request(http).post('/auth/verify-email/resend').expect(401);
    });
  });

  describe('sign-in and sessions', () => {
    it('gives the same 401 for a wrong password and an unknown email', async () => {
      const email = uniqueEmail('wrong');
      await signUp(email).expect(202);

      const wrong = await signInRaw(email, OTHER_PASSWORD).expect(401);
      const unknown = await signInRaw(uniqueEmail('nobody')).expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body).toEqual({
        statusCode: 401,
        message: 'Invalid email or password',
        error: 'Unauthorized',
      });
      expect(wrong.headers['set-cookie']).toBeUndefined();
    });

    it('sets an httpOnly, SameSite=Lax cookie for 30 days', async () => {
      const email = uniqueEmail('cookie');
      await signUp(email).expect(202);
      const res = await signInRaw(email).expect(200);
      const header = cookieHeader(res.headers['set-cookie']);

      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).toMatch(/Path=\//);
      expect(header).toMatch(`Max-Age=${SESSION_TTL_MS / 1000}`);
      expect(header).not.toMatch(/Secure/);
      expect(res.body.user).toEqual({
        id: expect.any(String),
        email,
        emailVerified: false,
      });
    });

    it('signs out: the old cookie gets 401 on me', async () => {
      const email = uniqueEmail('out');
      await signUp(email).expect(202);
      const cookie = await signIn(email);

      const res = await request(http)
        .post('/auth/sign-out')
        .set('Cookie', cookie)
        .expect(204);
      expect(cookieHeader(res.headers['set-cookie'])).toMatch(
        new RegExp(`^${SESSION_COOKIE}=;`),
      );
      await me(cookie).expect(401);
    });

    it('gives 401 on me without a cookie, or with a made-up one', async () => {
      await request(http).get('/auth/me').expect(401);
      await me(`${SESSION_COOKIE}=forged`).expect(401);
    });

    it('slides a used session forward, and expires an idle one after 30 days', async () => {
      const email = uniqueEmail('slide');
      await signUp(email).expect(202);
      const active = await signIn(email);
      const idle = await signIn(email);

      // Within the hour: no write, no new cookie.
      t.clock.advance(SESSION_SLIDE_INTERVAL_MS / 2);
      expect(
        (await me(active).expect(200)).headers['set-cookie'],
      ).toBeUndefined();

      t.clock.advance(29 * DAY_MS);
      const slid = await me(active).expect(200);
      expect(cookieHeader(slid.headers['set-cookie'])).toMatch(
        `Max-Age=${SESSION_TTL_MS / 1000}`,
      );

      t.clock.advance(DAY_MS);
      await me(idle).expect(401);
      await me(active).expect(200);
      // The expired session is deleted when it is seen.
      const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await t.prisma.session.count({ where: { userId: user.id } })).toBe(
        1,
      );
    });
  });

  describe('password reset', () => {
    it('resets: earlier sessions end, the old password fails, the new one works', async () => {
      const email = uniqueEmail('reset');
      await signUp(email).expect(202);
      const first = await signIn(email);
      const second = await signIn(email);

      const requested = await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      expect(requested.body).toEqual({});
      const message = t.mailer.to(email).at(-1);
      expect(message?.subject).toBe('Reset your DemoFlow password');
      expect(message?.link).toMatch(
        /^http:\/\/localhost:3670\/reset-password\?token=/,
      );
      const token = tokenFromLink(message?.link);

      const confirmed = await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token, password: OTHER_PASSWORD })
        .expect(204);
      expect(confirmed.headers['set-cookie']).toBeUndefined();

      await me(first).expect(401);
      await me(second).expect(401);
      await signInRaw(email, PASSWORD).expect(401);
      await signIn(email, OTHER_PASSWORD);

      await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token, password: 'yet another passphrase' })
        .expect(400);
    });

    it('answers an unknown email with the same 202 and sends nothing', async () => {
      const email = uniqueEmail('ghost');
      const res = await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      expect(res.body).toEqual({});
      expect(t.mailer.to(email)).toHaveLength(0);
    });

    it('refuses a reset link older than 1 hour', async () => {
      const email = uniqueEmail('stale');
      await signUp(email).expect(202);
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      t.clock.advance(HOUR_MS + 1000);

      await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token: lastLink(email), password: OTHER_PASSWORD })
        .expect(400);
      await signIn(email);
    });

    it('refuses a verification token used as a reset token', async () => {
      const email = uniqueEmail('swap');
      await signUp(email).expect(202);
      await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token: lastLink(email), password: OTHER_PASSWORD })
        .expect(400);
    });
  });

  describe('authorization', () => {
    it("me with A's cookie returns A, never B", async () => {
      const a = uniqueEmail('a');
      const b = uniqueEmail('b');
      await signUp(a).expect(202);
      await signUp(b).expect(202);
      const cookieA = await signIn(a);
      await signIn(b);

      expect((await me(cookieA).expect(200)).body.user.email).toBe(a);
    });

    it("A's session token, hashed, matches none of B's sessions", async () => {
      const a = uniqueEmail('a');
      const b = uniqueEmail('b');
      await signUp(a).expect(202);
      await signUp(b).expect(202);
      const tokenA = sessionToken(await signIn(a));
      await signIn(b);

      const userB = await t.prisma.user.findUniqueOrThrow({
        where: { email: b },
      });
      const sessionsB = await t.prisma.session.findMany({
        where: { userId: userB.id },
      });
      expect(sessionsB).toHaveLength(1);
      expect(sessionsB.map((s) => s.tokenHash)).not.toContain(
        hashToken(tokenA),
      );
      const owner = await t.prisma.session.findUniqueOrThrow({
        where: { tokenHash: hashToken(tokenA) },
        include: { user: true },
      });
      expect(owner.user.email).toBe(a);
    });

    it("a reset token issued for A cannot change B's password", async () => {
      const a = uniqueEmail('a');
      const b = uniqueEmail('b');
      await signUp(a).expect(202);
      await signUp(b).expect(202);
      const cookieB = await signIn(b);
      await request(http)
        .post('/auth/password-reset')
        .send({ email: a })
        .expect(202);

      // The body names no user: the token alone decides whose password changes.
      await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token: lastLink(a), password: OTHER_PASSWORD })
        .expect(204);

      await signIn(b, PASSWORD);
      await me(cookieB).expect(200);
      await signInRaw(a, PASSWORD).expect(401);
      await signIn(a, OTHER_PASSWORD);
    });
  });

  describe('VerifiedGuard', () => {
    it('gives 403 to an unverified session and 200 to a verified one', async () => {
      const unverified = uniqueEmail('unverified');
      await signUp(unverified).expect(202);
      const cookie = await signIn(unverified);
      await request(http)
        .get('/test-verified')
        .set('Cookie', cookie)
        .expect(403);

      const verified = await verifiedUser(uniqueEmail('verified'));
      await request(http)
        .get('/test-verified')
        .set('Cookie', verified)
        .expect(200);
    });

    it('gives 401 without a session', async () => {
      await request(http).get('/test-verified').expect(401);
    });
  });

  describe('CSRF', () => {
    it('refuses a state-changing request from another origin', async () => {
      const email = uniqueEmail('csrf');
      await signUp(email).expect(202);
      const cookie = await signIn(email);

      await request(http)
        .post('/auth/sign-out')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await me(cookie).expect(200);

      await request(http)
        .post('/auth/sign-out')
        .set('Cookie', cookie)
        .set('Origin', WEB_ORIGIN)
        .expect(204);
    });
  });

  describe('rate limits', () => {
    it('refuses the sixth sign-in attempt for one email within 15 minutes', async () => {
      const email = uniqueEmail('brute');
      await signUp(email).expect(202);
      for (let i = 0; i < 5; i += 1) {
        await signInRaw(email, OTHER_PASSWORD).expect(401);
      }
      await signInRaw(email).expect(429);
      // Another address is not affected.
      await signInRaw(uniqueEmail('bystander')).expect(401);
    });

    it('does not send a fourth reset email within an hour', async () => {
      const email = uniqueEmail('flood');
      await signUp(email).expect(202); // 1: the verification email
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      const before = t.mailer.to(email).length;

      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(429);
      expect(t.mailer.to(email)).toHaveLength(before);
    });

    it('counts reset emails per address, whatever the case', async () => {
      const email = uniqueEmail('mixed');
      for (const variant of [email, email.toUpperCase(), ` ${email} `]) {
        await request(http)
          .post('/auth/password-reset')
          .send({ email: variant })
          .expect(202);
      }
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(429);
    });

    it('allows 20 auth requests per IP in 10 minutes', async () => {
      for (let i = 0; i < 20; i += 1) {
        await signInRaw(uniqueEmail(`ip${i}`)).expect(401);
      }
      await signInRaw(uniqueEmail('ip20')).expect(429);
      // me is not counted: the web calls it on every page.
      await request(http).get('/auth/me').expect(401);
    });
  });

  describe('storage', () => {
    it('holds no plaintext password or token', async () => {
      const email = uniqueEmail('rows');
      await signUp(email).expect(202);
      const verifyToken = lastLink(email);
      const sessionCookieValue = await signIn(email);
      await request(http)
        .post('/auth/password-reset')
        .send({ email })
        .expect(202);
      const resetToken = lastLink(email);
      await request(http)
        .post('/auth/password-reset/confirm')
        .send({ token: resetToken, password: OTHER_PASSWORD })
        .expect(204);
      const secondSession = await signIn(email, OTHER_PASSWORD);

      const user = await t.prisma.user.findUniqueOrThrow({
        where: { email },
        include: { sessions: true, emailTokens: true },
      });
      const stored = JSON.stringify(user);
      for (const secret of [
        PASSWORD,
        OTHER_PASSWORD,
        verifyToken,
        resetToken,
        sessionToken(sessionCookieValue),
        sessionToken(secondSession),
      ]) {
        expect(stored).not.toContain(secret);
      }
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.sessions.map((s) => s.tokenHash)).toEqual([
        hashToken(sessionToken(secondSession)),
      ]);
      expect(user.emailTokens.map((e) => e.tokenHash).sort()).toEqual(
        [hashToken(verifyToken), hashToken(resetToken)].sort(),
      );
    });
  });
});

function cookieHeader(setCookie: string | string[] | undefined): string {
  const headers = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const header = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (!header) {
    throw new Error(`No ${SESSION_COOKIE} cookie was set`);
  }
  return header;
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  return cookieHeader(setCookie).split(';')[0];
}

function sessionToken(cookie: string): string {
  return decodeURIComponent(cookie.slice(`${SESSION_COOKIE}=`.length));
}
