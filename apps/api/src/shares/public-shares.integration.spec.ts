import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ShareStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordHasher } from '../auth/password-hasher';
import { generateToken } from '../auth/tokens';
import type { RunFormat } from '../projects/projects.dto';
import { type SignedIn, signedInUser } from '../runner/runner.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { SHARE_ACCESS_MS } from './share-access';
import { ShareConfig } from './share-config';
import { extensionOf } from './share-storage';

const FILE = randomBytes(5000);
const POSTER = randomBytes(300);
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE = 'Checkout flow 7f3a';
const DESCRIPTION = 'Buys one item.';
const PASSWORD = 'hunter22-correct-horse';
const WEB = 'http://web.test';

interface Made {
  id: string;
  token: string;
  runId: string;
  projectId: string;
}

interface MakeOptions {
  status?: ShareStatus;
  format?: string;
  /** From now; negative is already expired. */
  expiresInMs?: number;
  password?: string;
  /** Write `file.<ext>` and `poster.jpg` under the share's directory. */
  files?: boolean;
}

describe('public share links (integration)', () => {
  let t: TestApp;
  let http: App;
  let dir: string;
  let alice: SignedIn;
  let hasher: PasswordHasher;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'demoflow-public-shares-'));
    const config: ShareConfig = {
      dir,
      maxFileBytes: 10_000,
      quotaBytes: 20_000,
      webUrl: WEB,
    };
    t = await createTestApp([], [{ provide: ShareConfig, useValue: config }]);
    http = t.app.getHttpServer();
    alice = await signedInUser(t, 'alice');
    hasher = t.app.get(PasswordHasher);
  });

  afterEach(async () => {
    await t.app.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A share row as #347 leaves it, made directly, with its files on disk. */
  async function make(options: MakeOptions = {}): Promise<Made> {
    const format = options.format ?? 'mp4';
    const project = await t.prisma.project.create({
      data: { userId: alice.user.id, name: 'shop' },
    });
    const run = await t.prisma.run.create({
      data: {
        projectId: project.id,
        scenarioName: TITLE,
        scenarioPath: 'demos/checkout.demo.json',
        status: 'passed',
        startedAt: t.clock.now(),
        durationMs: 12_345,
        formats: [format],
        cliVersion: '0.7.0',
      },
    });
    const token = generateToken();
    const share = await t.prisma.share.create({
      data: {
        token,
        userId: alice.user.id,
        runId: run.id,
        format,
        status: options.status ?? 'ready',
        title: TITLE,
        description: DESCRIPTION,
        chapters: [
          { title: 'Open the cart', atMs: 0 },
          { title: 'Pay', atMs: 4000 },
        ],
        sizeBytes: FILE.length,
        posterBytes: POSTER.length,
        width: 1280,
        height: 720,
        durationMs: 12_000,
        passwordHash:
          options.password === undefined
            ? null
            : await hasher.hash(options.password),
        expiresAt: new Date(
          t.clock.now().getTime() + (options.expiresInMs ?? 30 * DAY_MS),
        ),
      },
    });
    if (options.files ?? true) {
      await mkdir(join(dir, share.id), { recursive: true });
      await writeFile(
        join(dir, share.id, `file.${extensionOf(format as RunFormat)}`),
        FILE,
      );
      await writeFile(join(dir, share.id, 'poster.jpg'), POSTER);
    }
    return { id: share.id, token, runId: run.id, projectId: project.id };
  }

  function page(token: string, cookie?: string): request.Test {
    const req = request(http).get(`/s/${token}`);
    return cookie === undefined ? req : req.set('Cookie', cookie);
  }

  function unlock(token: string, password = PASSWORD): request.Test {
    return request(http).post(`/s/${token}/unlock`).send({ password });
  }

  /** The `name=value` of the unlock cookie a right password answers with. */
  async function unlocked(token: string): Promise<string> {
    const res = await unlock(token).expect(204);
    const header = res.headers['set-cookie'] as unknown as string[];
    expect(header).toHaveLength(1);
    return header[0].split(';')[0];
  }

  async function views(id: string): Promise<number> {
    const share = await t.prisma.share.findUniqueOrThrow({ where: { id } });
    return share.views;
  }

  describe('what a share answers (Decision 2)', () => {
    it('an unknown or malformed token is 404', async () => {
      await page(generateToken()).expect(404, { error: 'not-found' });
      await page('nope').expect(404, { error: 'not-found' });
      await request(http).get(`/s/${generateToken()}/file`).expect(404);
      await request(http).get(`/s/${generateToken()}/poster`).expect(404);
    });

    it.each<ShareStatus>([
      'uploading',
      'failed',
    ])('a share still %s is 404', async (status) => {
      const share = await make({ status });
      await page(share.token).expect(404, { error: 'not-found' });
      await request(http).get(`/s/${share.token}/file`).expect(404);
      await request(http).get(`/s/${share.token}/poster`).expect(404);
    });

    it('an expired share is 410 expired before the sweeper ran', async () => {
      const share = await make({ expiresInMs: DAY_MS });
      await page(share.token).expect(200);
      t.clock.advance(DAY_MS);
      await page(share.token).expect(410, { error: 'expired' });
      await request(http)
        .get(`/s/${share.token}/file`)
        .expect(410, { error: 'expired' });
      await request(http).get(`/s/${share.token}/poster`).expect(410);
      // The row is still there: only the sweeper deletes it.
      expect(await t.prisma.share.count({ where: { id: share.id } })).toBe(1);
    });

    it('a lost share is 410 unavailable', async () => {
      const share = await make({ status: 'lost' });
      await page(share.token).expect(410, { error: 'unavailable' });
      await request(http)
        .get(`/s/${share.token}/file`)
        .expect(410, { error: 'unavailable' });
      await request(http).get(`/s/${share.token}/poster`).expect(410);
    });

    it('a ready share whose file is gone is 410 unavailable and marked lost', async () => {
      const page1 = await make({ files: false });
      await page(page1.token).expect(410, { error: 'unavailable' });
      expect(
        (await t.prisma.share.findUniqueOrThrow({ where: { id: page1.id } }))
          .status,
      ).toBe('lost');

      const file = await make({ files: false });
      await request(http)
        .get(`/s/${file.token}/file`)
        .expect(410, { error: 'unavailable' });
      expect(
        (await t.prisma.share.findUniqueOrThrow({ where: { id: file.id } }))
          .status,
      ).toBe('lost');
    });

    it('a share with a password and no cookie is locked, and nothing else', async () => {
      const share = await make({ password: PASSWORD });
      const res = await page(share.token).expect(200);
      expect(res.body).toEqual({ locked: true });
      expect(Object.keys(res.body)).toEqual(['locked']);
      await request(http)
        .get(`/s/${share.token}/file`)
        .expect(403, { error: 'locked' });
      await request(http)
        .get(`/s/${share.token}/poster`)
        .expect(403, { error: 'locked' });
    });

    it('a ready share answers its data, file and poster', async () => {
      const share = await make();
      const res = await page(share.token).expect(200);
      const url = `${WEB}/s/${share.token}`;
      expect(res.body).toEqual({
        title: TITLE,
        description: DESCRIPTION,
        chapters: [
          { title: 'Open the cart', atMs: 0 },
          { title: 'Pay', atMs: 4000 },
        ],
        format: 'mp4',
        kind: 'video',
        width: 1280,
        height: 720,
        durationMs: 12_000,
        sizeBytes: FILE.length,
        expiresAt: new Date(
          t.clock.now().getTime() + 30 * DAY_MS,
        ).toISOString(),
        fileUrl: `${url}/file`,
        posterUrl: `${url}/poster`,
        downloadUrl: `${url}/file?download=1`,
      });

      const file = await request(http)
        .get(`/s/${share.token}/file`)
        .expect(200);
      expect(file.headers['content-type']).toBe('video/mp4');
      expect(file.headers['content-length']).toBe(String(FILE.length));
      expect(file.headers['content-disposition']).toBe('inline');
      expect(Buffer.compare(file.body as Buffer, FILE)).toBe(0);

      const poster = await request(http)
        .get(`/s/${share.token}/poster`)
        .expect(200);
      expect(poster.headers['content-type']).toBe('image/jpeg');
      expect(Buffer.compare(poster.body as Buffer, POSTER)).toBe(0);
    });
  });

  describe('the file (Decision 4)', () => {
    it('answers a byte range with 206 and Content-Range', async () => {
      const share = await make();
      const res = await request(http)
        .get(`/s/${share.token}/file`)
        .set('Range', 'bytes=0-99')
        .expect(206);
      expect(res.headers['content-range']).toBe(`bytes 0-99/${FILE.length}`);
      expect(res.headers['content-length']).toBe('100');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.compare(res.body as Buffer, FILE.subarray(0, 100))).toBe(0);
    });

    it('answers a range past the end with 416', async () => {
      const share = await make();
      const res = await request(http)
        .get(`/s/${share.token}/file`)
        .set('Range', `bytes=${FILE.length}-`)
        .expect(416);
      expect(res.headers['content-range']).toBe(`bytes */${FILE.length}`);
    });

    it('answers HEAD with the headers and no body', async () => {
      const share = await make();
      const res = await request(http)
        .head(`/s/${share.token}/file`)
        .expect(200);
      expect(res.headers['content-length']).toBe(String(FILE.length));
      expect(res.headers['content-type']).toBe('video/mp4');
      await request(http).head(`/s/${share.token}/poster`).expect(200);
    });

    it('saves as an attachment with ?download=1', async () => {
      const share = await make();
      const res = await request(http)
        .get(`/s/${share.token}/file?download=1`)
        .expect(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="checkout-flow-7f3a-2026-10-20.mp4"',
      );
    });

    it('serves a GIF share as image/gif, kind image', async () => {
      const share = await make({ format: 'gif-vertical' });
      const data = await page(share.token).expect(200);
      expect(data.body).toMatchObject({
        format: 'gif-vertical',
        kind: 'image',
      });
      const res = await request(http).get(`/s/${share.token}/file`).expect(200);
      expect(res.headers['content-type']).toBe('image/gif');
    });

    it('without a password embeds anywhere and caches for 5 minutes', async () => {
      const share = await make();
      for (const asset of ['file', 'poster']) {
        const res = await request(http)
          .get(`/s/${share.token}/${asset}`)
          .expect(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'cross-origin',
        );
        expect(res.headers['cache-control']).toBe('public, max-age=300');
      }
    });

    it('with a password opens only with the unlock cookie, never cached', async () => {
      const share = await make({ password: PASSWORD });
      await request(http).get(`/s/${share.token}/file`).expect(403);
      const cookie = await unlocked(share.token);
      const res = await request(http)
        .get(`/s/${share.token}/file`)
        .set('Cookie', cookie)
        .expect(200);
      expect(Buffer.compare(res.body as Buffer, FILE)).toBe(0);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      await request(http)
        .get(`/s/${share.token}/poster`)
        .set('Cookie', cookie)
        .expect(200);
      const data = await page(share.token, cookie).expect(200);
      expect(data.body).toMatchObject({ title: TITLE });
    });
  });

  describe('unlock (Decisions 5–6)', () => {
    it('sets an HttpOnly, SameSite=Lax cookie for 12 hours', async () => {
      const share = await make({ password: PASSWORD });
      const res = await unlock(share.token).expect(204);
      const [cookie] = res.headers['set-cookie'] as unknown as string[];
      expect(cookie).toMatch(new RegExp(`^df_share_${share.id}=\\d+\\.`));
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain(`Max-Age=${SHARE_ACCESS_MS / 1000}`);
    });

    it('the cookie ends after 12 hours', async () => {
      const share = await make({ password: PASSWORD });
      const cookie = await unlocked(share.token);
      t.clock.advance(SHARE_ACCESS_MS);
      const res = await page(share.token, cookie).expect(200);
      expect(res.body).toEqual({ locked: true });
    });

    it('a wrong password is 401', async () => {
      const share = await make({ password: PASSWORD });
      const res = await unlock(share.token, 'wrong-password-1').expect(401, {
        error: 'wrong-password',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('a share without a password has nothing to unlock', async () => {
      const share = await make();
      const res = await unlock(share.token).expect(204);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('a password outside 8–128 characters is 400', async () => {
      const share = await make({ password: PASSWORD });
      await unlock(share.token, 'short').expect(400);
      await unlock(share.token, 'x'.repeat(129)).expect(400);
    });

    it('unlocks follow expiry and the 404 rows too', async () => {
      await unlock(generateToken()).expect(404);
      const expired = await make({ password: PASSWORD, expiresInMs: -1 });
      await unlock(expired.token).expect(410, { error: 'expired' });
    });

    it('the 11th attempt in 10 minutes from one address for one token is 429', async () => {
      const share = await make({ password: PASSWORD });
      const other = await make({ password: PASSWORD });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await unlock(share.token, 'wrong-password-1').expect(401);
      }
      await unlock(share.token, 'wrong-password-1').expect(429);
      // Right or wrong, the budget is spent for this token only.
      await unlock(share.token).expect(429);
      await unlock(other.token).expect(204);
    });

    it('a cookie signed for share A does not open share B', async () => {
      const a = await make({ password: PASSWORD });
      const b = await make({ password: PASSWORD });
      const cookie = await unlocked(a.token);
      const value = cookie.split('=')[1];
      for (const sent of [cookie, `df_share_${b.id}=${value}`]) {
        const res = await page(b.token, sent).expect(200);
        expect(res.body).toEqual({ locked: true });
        await request(http)
          .get(`/s/${b.token}/file`)
          .set('Cookie', sent)
          .expect(403);
      }
    });

    it('a cross-origin unlock is refused', async () => {
      const share = await make({ password: PASSWORD });
      await unlock(share.token)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });
  });

  describe('views (Decision 7)', () => {
    it('grow by one per unlocked page load, not on file, poster or locked', async () => {
      const open = await make();
      await page(open.token).expect(200);
      await page(open.token).expect(200);
      await request(http).get(`/s/${open.token}/file`).expect(200);
      await request(http).get(`/s/${open.token}/poster`).expect(200);
      await request(http).head(`/s/${open.token}/file`).expect(200);
      expect(await views(open.id)).toBe(2);

      const locked = await make({ password: PASSWORD });
      await page(locked.token).expect(200);
      expect(await views(locked.id)).toBe(0);
      const cookie = await unlocked(locked.token);
      await page(locked.token, cookie).expect(200);
      await request(http)
        .get(`/s/${locked.token}/file`)
        .set('Cookie', cookie)
        .expect(200);
      expect(await views(locked.id)).toBe(1);
    });
  });

  describe('authorization', () => {
    it('never answers by id, and never names a user, run, project or share', async () => {
      const share = await make();
      for (const key of [
        share.id,
        share.runId,
        share.projectId,
        alice.user.id,
      ]) {
        await page(key).expect(404);
        await request(http).get(`/s/${key}/file`).expect(404);
      }
      const res = await page(share.token).expect(200);
      const body = JSON.stringify(res.body);
      for (const key of [
        share.id,
        share.runId,
        share.projectId,
        alice.user.id,
      ]) {
        expect(body).not.toContain(key);
      }
      for (const key of [
        'id',
        'userId',
        'runId',
        'projectId',
        'token',
        'views',
      ]) {
        expect(res.body).not.toHaveProperty(key);
      }
    });

    it("one share's token never reaches another's file", async () => {
      const a = await make();
      const b = await make();
      await writeFile(join(dir, b.id, 'file.mp4'), randomBytes(5000));
      const res = await request(http).get(`/s/${a.token}/file`).expect(200);
      expect(Buffer.compare(res.body as Buffer, FILE)).toBe(0);
    });
  });

  describe('logging', () => {
    it('never logs an address or a token', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation((...args: unknown[]) => {
              lines.push(args.map(String).join(' '));
            }),
      );
      try {
        const open = await make();
        const locked = await make({ password: PASSWORD });
        const gone = await make({ files: false });
        await page(open.token).expect(200);
        await request(http).get(`/s/${open.token}/file`).expect(200);
        await page(locked.token).expect(200);
        await unlock(locked.token, 'wrong-password-1').expect(401);
        await unlocked(locked.token);
        await page(gone.token).expect(410);

        const all = lines.join('\n');
        expect(all).toContain('share.lost');
        for (const secret of [
          open.token,
          locked.token,
          gone.token,
          '127.0.0.1',
          PASSWORD,
        ]) {
          expect(all).not.toContain(secret);
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  });
});
