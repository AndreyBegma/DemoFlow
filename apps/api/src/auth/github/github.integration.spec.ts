import { Logger } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  type FakeAccount,
  FakeGithub,
  fakeGithubConfig,
} from '../../test/fake-github';
import {
  createTestApp,
  type TestApp,
  tokenFromLink,
  uniqueEmail,
} from '../../test/test-app';
import { SESSION_COOKIE } from '../session-cookie';
import { GithubClient } from './github.client';
import { codeChallenge } from './github-auth.service';
import { GithubConfig } from './github-config';
import { OAUTH_COOKIE } from './oauth-cookie';

const WEB = 'http://localhost:3670';
const PASSWORD = 'correct horse battery';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

/** `name=value` of a cookie the response set. */
function cookiePair(
  setCookie: string | string[] | undefined,
  name: string,
): string {
  const header = asList(setCookie).find((h) => h.startsWith(`${name}=`));
  if (!header) {
    throw new Error(`No ${name} cookie was set`);
  }
  return header.split(';')[0];
}

function setCookies(res: request.Response): string[] {
  return asList(res.headers['set-cookie']);
}

function asList(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

describe('GitHub sign-in (integration)', () => {
  let t: TestApp;
  let http: App;
  let github: FakeGithub;

  async function boot(clientId = CLIENT_ID, clientSecret = CLIENT_SECRET) {
    github = new FakeGithub();
    t = await createTestApp(
      [],
      [
        { provide: GithubClient, useValue: github },
        {
          provide: GithubConfig,
          useValue: fakeGithubConfig(clientId, clientSecret, WEB),
        },
      ],
    );
    http = t.app.getHttpServer();
  }

  afterEach(async () => {
    await t.app.close();
  });

  interface Flow {
    oauthCookie: string;
    state: string;
    challenge: string;
    location: URL;
  }

  async function start(
    intent: 'sign-in' | 'link',
    session?: string,
  ): Promise<Flow> {
    const req = request(http).get(`/auth/github/start?intent=${intent}`);
    if (session) req.set('Cookie', session);
    const res = await req.expect(302);
    const location = new URL(res.headers.location);
    return {
      oauthCookie: cookiePair(res.headers['set-cookie'], OAUTH_COOKIE),
      state: location.searchParams.get('state') ?? '',
      challenge: location.searchParams.get('code_challenge') ?? '',
      location,
    };
  }

  function callback(
    query: Record<string, string>,
    cookies: (string | undefined)[],
  ) {
    const req = request(http).get('/auth/github/callback').query(query);
    const header = cookies.filter((c): c is string => !!c).join('; ');
    if (header) req.set('Cookie', header);
    return req.expect(302);
  }

  /** A whole sign-in: start, GitHub answers with the account's code. */
  async function signInWith(account: FakeAccount, session?: string) {
    const flow = await start('sign-in', session);
    return callback({ code: account.code, state: flow.state }, [
      flow.oauthCookie,
      session,
    ]);
  }

  async function linkWith(account: FakeAccount, session: string) {
    const flow = await start('link', session);
    return callback({ code: account.code, state: flow.state }, [
      flow.oauthCookie,
      session,
    ]);
  }

  function me(session: string) {
    return request(http).get('/auth/me').set('Cookie', session).expect(200);
  }

  /** An email/password account, verified unless said, and its session. */
  async function passwordUser(email: string, verified = true): Promise<string> {
    await request(http)
      .post('/auth/sign-up')
      .send({ email, password: PASSWORD })
      .expect(202);
    if (verified) {
      const [message] = t.mailer.to(email);
      await request(http)
        .post('/auth/verify-email')
        .send({ token: tokenFromLink(message?.link) })
        .expect(204);
    }
    const res = await request(http)
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return cookiePair(res.headers['set-cookie'], SESSION_COOKIE);
  }

  describe('configured', () => {
    beforeEach(() => boot());

    it('reports GitHub as available', async () => {
      const res = await request(http).get('/auth/providers').expect(200);
      expect(res.body).toEqual({ github: true });
    });

    it('starts with state, PKCE S256, the scopes and the fixed callback', async () => {
      const flow = await start('sign-in');
      expect(flow.location.origin + flow.location.pathname).toBe(
        'https://github.com/login/oauth/authorize',
      );
      const q = flow.location.searchParams;
      expect(q.get('client_id')).toBe(CLIENT_ID);
      expect(q.get('scope')).toBe('read:user user:email');
      expect(q.get('redirect_uri')).toBe(`${WEB}/api/auth/github/callback`);
      expect(q.get('code_challenge_method')).toBe('S256');
      expect(flow.state.length).toBeGreaterThanOrEqual(43);

      const res = await request(http)
        .get('/auth/github/start?intent=sign-in')
        .expect(302);
      const header = setCookies(res).find((h) =>
        h.startsWith(`${OAUTH_COOKIE}=`),
      );
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).toMatch('Max-Age=600');
    });

    it('sends the PKCE verifier that matches the challenge', async () => {
      const account = github.account({ email: uniqueEmail('pkce') });
      const flow = await start('sign-in');
      await callback({ code: account.code, state: flow.state }, [
        flow.oauthCookie,
      ]);
      const [exchange] = github.exchanges;
      expect(codeChallenge(exchange.codeVerifier)).toBe(flow.challenge);
      expect(exchange.redirectUri).toBe(`${WEB}/api/auth/github/callback`);
    });

    it('refuses an unknown intent with 400', async () => {
      await request(http).get('/auth/github/start?intent=admin').expect(400);
    });

    describe('sign-in: account resolution', () => {
      it('creates a verified account without a password for a new GitHub user', async () => {
        const email = uniqueEmail('new');
        const account = github.account({ email: email.toUpperCase() });
        const res = await signInWith(account);

        expect(res.headers.location).toBe(`${WEB}/app`);
        const session = cookiePair(res.headers['set-cookie'], SESSION_COOKIE);
        expect((await me(session)).body.user).toEqual({
          id: expect.any(String),
          email,
          emailVerified: true,
          githubLinked: true,
          hasPassword: false,
        });
        const identity = await t.prisma.githubIdentity.findUnique({
          where: { githubUserId: account.user.id },
        });
        expect(identity?.login).toBe(account.user.login);
      });

      it('links a verified email account with the same email, without a second user', async () => {
        const email = uniqueEmail('verified');
        await passwordUser(email);
        const before = await t.prisma.user.findUniqueOrThrow({
          where: { email },
        });

        const res = await signInWith(github.account({ email }));
        expect(res.headers.location).toBe(`${WEB}/app`);
        const session = cookiePair(res.headers['set-cookie'], SESSION_COOKIE);
        const { user } = (await me(session)).body;
        expect(user).toMatchObject({
          id: before.id,
          githubLinked: true,
          hasPassword: true,
        });
        expect(await t.prisma.user.count({ where: { email } })).toBe(1);
      });

      it('refuses an unverified email account, and links nothing', async () => {
        const email = uniqueEmail('unverified');
        await passwordUser(email, false);
        const account = github.account({ email });

        const res = await signInWith(account);
        expect(res.headers.location).toBe(
          `${WEB}/sign-in?error=github_link_requires_verified`,
        );
        expect(setCookies(res).join()).not.toMatch(`${SESSION_COOKIE}=`);
        expect(
          await t.prisma.githubIdentity.findUnique({
            where: { githubUserId: account.user.id },
          }),
        ).toBeNull();
      });

      it('refuses a GitHub account without a verified primary email', async () => {
        const email = uniqueEmail('noprimary');
        for (const emails of [
          [],
          [{ email, primary: true, verified: false }],
          // A verified address that is not the primary one does not count.
          [
            { email, primary: false, verified: true },
            { email: uniqueEmail('p'), primary: true, verified: false },
          ],
        ]) {
          const res = await signInWith(github.account({ emails }));
          expect(res.headers.location).toBe(
            `${WEB}/sign-in?error=github_no_verified_email`,
          );
          expect(setCookies(res).join()).not.toMatch(`${SESSION_COOKIE}=`);
        }
        expect(await t.prisma.user.findUnique({ where: { email } })).toBeNull();
      });

      it('matches a returning GitHub user by id, even after an email change', async () => {
        const email = uniqueEmail('returning');
        const account = github.account({ email });
        const first = await signInWith(account);
        const firstUser = (
          await me(cookiePair(first.headers['set-cookie'], SESSION_COOKIE))
        ).body.user;

        const changed = github.again(account, [
          { email: uniqueEmail('changed'), primary: true, verified: true },
        ]);
        const second = await signInWith(changed);
        const secondUser = (
          await me(cookiePair(second.headers['set-cookie'], SESSION_COOKIE))
        ).body.user;
        expect(secondUser.id).toBe(firstUser.id);
        expect(secondUser.email).toBe(email);
      });

      it('refuses a verified account already holding another GitHub account', async () => {
        const email = uniqueEmail('holder');
        await signInWith(github.account({ email }));
        const res = await signInWith(github.account({ email }));
        expect(res.headers.location).toBe(
          `${WEB}/sign-in?error=github_already_linked`,
        );
      });

      it('leaves an existing session row alone, like email sign-in', async () => {
        const email = uniqueEmail('resign');
        const old = await passwordUser(email);
        const res = await signInWith(github.account({ email }), old);
        expect(res.headers.location).toBe(`${WEB}/app`);
        // Same as POST /auth/sign-in: a new session; the old one still works.
        await me(old);
      });
    });

    describe('state and cookie', () => {
      it('refuses a state mismatch: error redirect, no session', async () => {
        const account = github.account({ email: uniqueEmail('mismatch') });
        const flow = await start('sign-in');
        const res = await callback({ code: account.code, state: 'forged' }, [
          flow.oauthCookie,
        ]);
        expect(res.headers.location).toBe(
          `${WEB}/sign-in?error=github_state_invalid`,
        );
        expect(setCookies(res).join()).not.toMatch(`${SESSION_COOKIE}=`);
        expect(github.exchanges).toHaveLength(0);
      });

      it('refuses a missing df_oauth cookie: error redirect, no session', async () => {
        const account = github.account({ email: uniqueEmail('nocookie') });
        const flow = await start('sign-in');
        const res = await callback(
          { code: account.code, state: flow.state },
          [],
        );
        expect(res.headers.location).toBe(
          `${WEB}/sign-in?error=github_state_invalid`,
        );
        expect(setCookies(res).join()).not.toMatch(`${SESSION_COOKIE}=`);
      });

      it('refuses a tampered cookie and an expired one', async () => {
        const account = github.account({ email: uniqueEmail('tamper') });
        const flow = await start('sign-in');
        const [name, value] = flow.oauthCookie.split('=');
        const [payload, mac] = decodeURIComponent(value).split('.');
        const forged = Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
            intent: 'link',
          }),
        ).toString('base64url');
        const tampered = await callback(
          { code: account.code, state: flow.state },
          [`${name}=${forged}.${mac}`],
        );
        expect(tampered.headers.location).toBe(
          `${WEB}/sign-in?error=github_state_invalid`,
        );

        const late = await start('sign-in');
        t.clock.advance(10 * 60 * 1000 + 1);
        const expired = await callback(
          { code: account.code, state: late.state },
          [late.oauthCookie],
        );
        expect(expired.headers.location).toBe(
          `${WEB}/sign-in?error=github_state_invalid`,
        );
      });

      it('clears df_oauth on the callback', async () => {
        const account = github.account({ email: uniqueEmail('clear') });
        const res = await signInWith(account);
        const header = setCookies(res).find((h) =>
          h.startsWith(`${OAUTH_COOKIE}=`),
        );
        expect(header).toMatch(/Expires=Thu, 01 Jan 1970/);
      });

      it('maps a denial on GitHub to github_denied', async () => {
        const flow = await start('sign-in');
        const res = await callback(
          {
            error: 'access_denied',
            error_description: 'The user has denied your application access.',
            error_uri: 'https://docs.github.com/',
            state: flow.state,
          },
          [flow.oauthCookie],
        );
        expect(res.headers.location).toBe(`${WEB}/sign-in?error=github_denied`);
      });

      it('maps a GitHub failure to github_failed', async () => {
        const flow = await start('sign-in');
        const res = await callback({ code: 'unknown', state: flow.state }, [
          flow.oauthCookie,
        ]);
        expect(res.headers.location).toBe(`${WEB}/sign-in?error=github_failed`);
      });
    });

    describe('link from settings', () => {
      it('needs a session to start', async () => {
        await request(http).get('/auth/github/start?intent=link').expect(401);
      });

      it('attaches the identity, whatever the emails', async () => {
        const session = await passwordUser(uniqueEmail('linker'));
        const account = github.account({ email: uniqueEmail('other') });
        const res = await linkWith(account, session);
        expect(res.headers.location).toBe(`${WEB}/app/settings`);
        expect((await me(session)).body.user.githubLinked).toBe(true);
        // The GitHub email is not stored anywhere (Decision 6).
        expect(
          await t.prisma.user.count({
            where: { email: account.emails[0].email },
          }),
        ).toBe(0);
      });

      it('authorization: refuses a GitHub account owned by user B while signed in as A, and B keeps it', async () => {
        const accountOfB = github.account({ email: uniqueEmail('b') });
        const b = await signInWith(accountOfB);
        const bSession = cookiePair(b.headers['set-cookie'], SESSION_COOKIE);
        const bId = (await me(bSession)).body.user.id;

        const a = await passwordUser(uniqueEmail('a'));
        const res = await linkWith(github.again(accountOfB), a);
        expect(res.headers.location).toBe(
          `${WEB}/app/settings?error=github_already_linked_elsewhere`,
        );
        expect((await me(a)).body.user.githubLinked).toBe(false);
        const identity = await t.prisma.githubIdentity.findUnique({
          where: { githubUserId: accountOfB.user.id },
        });
        expect(identity?.userId).toBe(bId);
      });

      it('refuses when the user already has a GitHub identity', async () => {
        const session = await passwordUser(uniqueEmail('twice'));
        await linkWith(github.account({}), session);
        const res = await linkWith(github.account({}), session);
        expect(res.headers.location).toBe(
          `${WEB}/app/settings?error=github_already_linked`,
        );
      });

      it('refuses a callback whose session is not the one that started the link', async () => {
        const a = await passwordUser(uniqueEmail('starter'));
        const other = await passwordUser(uniqueEmail('swapped'));
        const account = github.account({});
        const flow = await start('link', a);

        for (const session of [other, undefined]) {
          const res = await callback(
            { code: account.code, state: flow.state },
            [flow.oauthCookie, session],
          );
          expect(res.headers.location).toBe(
            `${WEB}/app/settings?error=github_state_invalid`,
          );
        }
        expect((await me(a)).body.user.githubLinked).toBe(false);
        expect((await me(other)).body.user.githubLinked).toBe(false);
      });
    });

    describe('unlink', () => {
      it('gives 204 with a password, and the identity is gone', async () => {
        const session = await passwordUser(uniqueEmail('unlink'));
        await linkWith(github.account({}), session);
        await request(http)
          .delete('/auth/github')
          .set('Cookie', session)
          .set('Origin', WEB)
          .expect(204);
        expect((await me(session)).body.user.githubLinked).toBe(false);
      });

      it('gives 409 without a password, and keeps the identity', async () => {
        const res = await signInWith(
          github.account({ email: uniqueEmail('gh') }),
        );
        const session = cookiePair(res.headers['set-cookie'], SESSION_COOKIE);
        const refused = await request(http)
          .delete('/auth/github')
          .set('Cookie', session)
          .expect(409);
        expect(refused.body.message).toBe('github_unlink_requires_password');
        expect((await me(session)).body.user.githubLinked).toBe(true);
      });

      it('needs a session, and refuses a cross-origin request', async () => {
        await request(http).delete('/auth/github').expect(401);
        const session = await passwordUser(uniqueEmail('csrf'));
        await request(http)
          .delete('/auth/github')
          .set('Cookie', session)
          .set('Origin', 'https://evil.example')
          .expect(403);
      });
    });

    describe('the access token', () => {
      it('never reaches the database or the logs', async () => {
        const captured: string[] = [];
        const capture = (chunk: unknown): boolean => {
          captured.push(String(chunk));
          return true;
        };
        const record = (...args: unknown[]): void => {
          captured.push(args.map(String).join(' '));
        };
        const spies = [
          jest.spyOn(process.stdout, 'write').mockImplementation(capture),
          jest.spyOn(process.stderr, 'write').mockImplementation(capture),
          ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
            jest.spyOn(console, m).mockImplementation(record),
          ),
          ...(
            ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const
          ).map((m) =>
            jest.spyOn(Logger.prototype, m).mockImplementation(record),
          ),
        ];

        let tokens: string[];
        try {
          const ok = github.account({ email: uniqueEmail('token') });
          await signInWith(ok);
          const linked = github.account({});
          await linkWith(linked, await passwordUser(uniqueEmail('tok-link')));
          // A failure after the exchange is the path that logs.
          github.failEmails = true;
          const failing = github.account({ email: uniqueEmail('tok-fail') });
          const res = await signInWith(failing);
          expect(res.headers.location).toBe(
            `${WEB}/sign-in?error=github_failed`,
          );
          tokens = [ok.token, linked.token, failing.token];
        } finally {
          for (const spy of spies) spy.mockRestore();
        }

        // The spy saw the warning, so a leaked token would have been seen too.
        const logs = captured.join('\n');
        expect(logs).toMatch('GitHub emails: HTTP 502');
        for (const token of tokens) {
          expect(logs).not.toContain(token);
        }

        const rows = await t.prisma.$queryRaw<{ row: string }[]>`
          SELECT row_to_json(u)::text AS row FROM "User" u
          UNION ALL SELECT row_to_json(s)::text FROM "Session" s
          UNION ALL SELECT row_to_json(e)::text FROM "EmailToken" e
          UNION ALL SELECT row_to_json(g)::text FROM "GithubIdentity" g`;
        const dump = rows.map((r) => r.row).join('\n');
        expect(dump.length).toBeGreaterThan(0);
        for (const token of tokens) {
          expect(dump).not.toContain(token);
        }
      });
    });
  });

  describe('not configured', () => {
    it.each([
      ['', ''],
      [CLIENT_ID, ''],
      ['', CLIENT_SECRET],
    ])('id %j / secret %j: providers false, start 404', async (id, secret) => {
      await boot(id, secret);
      const res = await request(http).get('/auth/providers').expect(200);
      expect(res.body).toEqual({ github: false });
      await request(http).get('/auth/github/start?intent=sign-in').expect(404);
    });
  });
});
