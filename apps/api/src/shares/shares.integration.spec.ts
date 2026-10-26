import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { generateToken } from '../auth/tokens';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { eventually, TestSocket } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { HEAD_TIMEOUT_MS, VideoRelay } from '../videos/video-relay.service';
import { ShareConfig } from './share-config';
import { ShareStorage } from './share-storage';
import { ShareSweeper } from './share-sweeper';

const FILE = randomBytes(5000);
const POSTER = randomBytes(300);
const MAX_FILE = 10_000;
const QUOTA = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE = 'Checkout flow 7f3a';
const DESCRIPTION = 'Buys one item, secret description 9c2e.';
const PASSWORD = 'hunter22-correct-horse';

interface ShareBody {
  id: string;
  url: string;
  fileUrl: string | null;
  status: string;
  failure: string | null;
  sizeBytes: number;
  expiresAt: string;
}

describe('share links (integration)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let dir: string;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  let runId: string;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'demoflow-shares-'));
    const config: ShareConfig = {
      dir,
      maxFileBytes: MAX_FILE,
      quotaBytes: QUOTA,
      webUrl: 'http://web.test',
    };
    t = await createTestApp([], [{ provide: ShareConfig, useValue: config }]);
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice, 'Laptop');
    runId = await report(machine);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    // Uploads still waiting settle on the closed sockets before the app goes.
    await eventually(async () => {
      const uploading = await t.prisma.share.count({
        where: {
          run: { project: { userId: alice.user.id } },
          status: 'uploading',
        },
      });
      return uploading === 0;
    }).catch(() => undefined);
    await t.app.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A run with `mp4`, `webm` and `gif`; `sizes` sets what `renders` says. */
  async function report(
    by: Paired,
    sizes: Record<string, number> = { mp4: 6000, webm: 6000, gif: 6000 },
  ): Promise<string> {
    const formats = Object.keys(sizes);
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${by.token}`)
      .send({
        rootPath: '/home/alice/shop',
        projectName: 'shop',
        scenarioName: TITLE,
        scenarioPath: 'demos/checkout.yaml',
        status: 'passed',
        startedAt: t.clock.now().toISOString(),
        durationMs: 12_345,
        formats,
        cliVersion: '0.7.0',
        renders: formats.map((format) => ({
          format,
          width: 1280,
          height: 720,
          sizeBytes: sizes[format],
          durationMs: 12_000,
        })),
      })
      .expect(201);
    return res.body.runId;
  }

  /** A daemon on `by`'s token that announced `features`; `null` sends none. */
  async function daemon(
    by: Paired = machine,
    features: string[] | null = ['share'],
  ): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      by.token,
    );
    sockets.push(socket);
    socket.sync([], undefined, features ?? undefined);
    await socket.roundTrip();
    return socket;
  }

  function create(
    body: Record<string, unknown>,
    cookie = alice.cookie,
  ): request.Test {
    return request(http).post('/shares').set('Cookie', cookie).send(body);
  }

  /** Answers `share.prepare`, then serves the poster and the render. */
  async function serveShare(socket: TestSocket, file = FILE): Promise<void> {
    const prepare = await socket.nextShare();
    socket.send({
      type: 'share.prepared',
      requestId: prepare.requestId,
      description: DESCRIPTION,
      chapters: [
        { title: 'Open the cart', atMs: 0 },
        { title: 'Pay', atMs: 4000 },
      ],
      posterSize: POSTER.length,
    });
    const poster = await socket.nextOpen();
    socket.serve(poster.streamId, POSTER);
    const render = await socket.nextOpen();
    socket.serve(render.streamId, file);
  }

  async function shareOf(id: string): Promise<ShareBody> {
    const res = await request(http)
      .get(`/shares/${id}`)
      .set('Cookie', alice.cookie)
      .expect(200);
    return res.body as ShareBody;
  }

  async function settled(id: string, status: string): Promise<ShareBody> {
    await eventually(async () => (await shareOf(id)).status === status);
    return shareOf(id);
  }

  async function ready(format = 'mp4', run = runId): Promise<string> {
    const socket = sockets[0] ?? (await daemon());
    const res = await create({ runId: run, format }).expect(202);
    await serveShare(socket);
    await settled(res.body.id, 'ready');
    return res.body.id;
  }

  /** Every entry left under the share's directory, `.part` files included. */
  async function filesOf(id: string): Promise<string[] | null> {
    try {
      return (await readdir(join(dir, id))).sort();
    } catch {
      return null;
    }
  }

  describe('upload', () => {
    it('pulls the poster and the render, then the share is ready', async () => {
      const socket = await daemon();
      const res = await create({ runId, format: 'mp4' }).expect(202);
      expect(res.body).toMatchObject({
        status: 'uploading',
        runId,
        title: TITLE,
        format: 'mp4',
        hasPassword: false,
        views: 0,
        failure: null,
      });
      const token = (res.body.url as string).replace('http://web.test/s/', '');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.fileUrl).toBe(`${res.body.url}/file`);
      expect(res.body).not.toHaveProperty('token');
      expect(res.body).not.toHaveProperty('passwordHash');

      const prepare = await socket.nextShare();
      expect(prepare).toMatchObject({ runId, format: 'mp4' });
      socket.send({
        type: 'share.prepared',
        requestId: prepare.requestId,
        description: DESCRIPTION,
        chapters: [{ title: 'Open the cart', atMs: 0 }],
        posterSize: POSTER.length,
      });
      const poster = await socket.nextOpen();
      expect(poster).toMatchObject({
        runId,
        format: 'mp4',
        range: null,
        asset: 'poster',
      });
      socket.serve(poster.streamId, POSTER);
      const render = await socket.nextOpen();
      expect(render).toMatchObject({ runId, format: 'mp4', range: null });
      expect(render).not.toHaveProperty('asset');
      socket.serve(render.streamId, FILE);

      const share = await settled(res.body.id, 'ready');
      expect(share).toMatchObject({
        sizeBytes: FILE.length,
        width: 1280,
        height: 720,
        durationMs: 12_000,
      });
      expect(await filesOf(share.id)).toEqual(['file.mp4', 'poster.jpg']);
      expect(await readFile(join(dir, share.id, 'file.mp4'))).toEqual(FILE);
      expect(await readFile(join(dir, share.id, 'poster.jpg'))).toEqual(POSTER);
      const row = await t.prisma.share.findUniqueOrThrow({
        where: { id: share.id },
      });
      expect(row).toMatchObject({
        description: DESCRIPTION,
        chapters: [{ title: 'Open the cart', atMs: 0 }],
        posterBytes: POSTER.length,
      });

      const list = await request(http)
        .get('/shares')
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(list.body.shares.map((s: ShareBody) => s.id)).toEqual([share.id]);
      expect(list.body.quota).toEqual({
        usedBytes: FILE.length + POSTER.length,
        limitBytes: QUOTA,
        maxFileBytes: MAX_FILE,
      });
    });

    it('keeps only the hash of a password and hides the file URL', async () => {
      await daemon();
      const res = await create({
        runId,
        format: 'mp4',
        password: PASSWORD,
        expiresInDays: 7,
      }).expect(202);
      expect(res.body).toMatchObject({ hasPassword: true, fileUrl: null });
      expect(new Date(res.body.expiresAt).getTime()).toBe(
        t.clock.now().getTime() + 7 * DAY_MS,
      );
      const row = await t.prisma.share.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('validates the body', async () => {
      await create({ runId, format: 'mp4', expiresInDays: 14 }).expect(400);
      await create({ runId, format: 'mp4', password: 'short' }).expect(400);
      await create({ runId, format: 'mov' }).expect(400);
      await create({ runId, format: 'mp4', extra: 1 }).expect(400);
    });

    it('answers share-exists for a second share of the same render', async () => {
      await daemon();
      const first = await create({ runId, format: 'mp4' }).expect(202);
      const second = await create({ runId, format: 'mp4' }).expect(409);
      expect(second.body).toEqual({
        error: 'share-exists',
        shareId: first.body.id,
      });
    });

    it('replaces a failed share of the same render', async () => {
      const socket = await daemon();
      const first = await create({ runId, format: 'mp4' }).expect(202);
      const prepare = await socket.nextShare();
      socket.send({
        type: 'share.error',
        requestId: prepare.requestId,
        code: 'io',
      });
      await settled(first.body.id, 'failed');
      const second = await create({ runId, format: 'mp4' }).expect(202);
      expect(second.body.id).not.toBe(first.body.id);
      expect(await t.prisma.share.count({ where: { id: first.body.id } })).toBe(
        0,
      );
    });

    it('refuses a format the run did not render', async () => {
      await daemon();
      const res = await create({ runId, format: 'webm-square' }).expect(409);
      expect(res.body).toEqual({ error: 'format-not-rendered' });
    });
  });

  describe('the machine', () => {
    it('sends nothing to a daemon without `share`: runner-outdated', async () => {
      const socket = await daemon(machine, null);
      const res = await create({ runId, format: 'mp4' }).expect(409);
      expect(res.body).toEqual({ error: 'runner-outdated' });
      await socket.roundTrip();
      expect(socket.received.map((m) => m.type)).not.toContain('share.prepare');
      expect(await t.prisma.share.count({ where: { runId } })).toBe(0);
    });

    it('answers runner-offline without a socket', async () => {
      const res = await create({ runId, format: 'mp4' }).expect(409);
      expect(res.body).toEqual({ error: 'runner-offline' });
    });

    it('refuses a run whose files were deleted', async () => {
      await daemon();
      await t.prisma.run.update({
        where: { id: runId },
        data: { artifactsDeletedAt: t.clock.now() },
      });
      const res = await create({ runId, format: 'mp4' }).expect(409);
      expect(res.body).toEqual({ error: 'artifacts-deleted' });
    });

    it('shows the features on the run page', async () => {
      await daemon();
      const res = await request(http)
        .get(`/runs/${runId}`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(res.body.machine.features).toEqual(['share']);
    });
  });

  describe('limits', () => {
    it('answers 413 before any message for a render over the file limit', async () => {
      const big = await report(machine, { mp4: MAX_FILE + 1 });
      const socket = await daemon();
      const res = await create({ runId: big, format: 'mp4' }).expect(413);
      expect(res.body).toEqual({
        error: 'file-too-large',
        maxFileBytes: MAX_FILE,
      });
      await socket.roundTrip();
      expect(socket.received.map((m) => m.type)).not.toContain('share.prepare');
    });

    it('cancels a head over the file limit and fails the share', async () => {
      const socket = await daemon();
      const res = await create({ runId, format: 'mp4' }).expect(202);
      const prepare = await socket.nextShare();
      socket.send({
        type: 'share.prepared',
        requestId: prepare.requestId,
        chapters: [],
        posterSize: POSTER.length,
      });
      const poster = await socket.nextOpen();
      socket.serve(poster.streamId, POSTER);
      const render = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: render.streamId,
        size: MAX_FILE + 1,
        start: 0,
        end: MAX_FILE,
      });
      const cancel = await socket.next('video.cancel');
      expect(cancel.streamId).toBe(render.streamId);
      const share = await settled(res.body.id, 'failed');
      expect(share.failure).toBe('file-too-large');
      expect(await filesOf(share.id)).toBeNull();
    });

    it('answers quota-exceeded, and a delete frees the bytes', async () => {
      await daemon();
      // 6000 bytes reserved per uploading share, from the run's renders.
      const mp4 = await create({ runId, format: 'mp4' }).expect(202);
      await create({ runId, format: 'webm' }).expect(202);
      await create({ runId, format: 'gif' }).expect(202);
      const other = await report(machine, { mp4: 6000 });
      const over = await create({ runId: other, format: 'mp4' }).expect(409);
      expect(over.body).toEqual({
        error: 'quota-exceeded',
        usedBytes: 18_000,
        limitBytes: QUOTA,
      });
      await request(http)
        .delete(`/shares/${mp4.body.id}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      await create({ runId: other, format: 'mp4' }).expect(202);
    });
  });

  describe('failures', () => {
    it('share.error fails the share', async () => {
      const socket = await daemon();
      const res = await create({ runId, format: 'mp4' }).expect(202);
      const prepare = await socket.nextShare();
      socket.send({
        type: 'share.error',
        requestId: prepare.requestId,
        code: 'no-render',
      });
      const share = await settled(res.body.id, 'failed');
      expect(share.failure).toBe('no-render');
      expect(await filesOf(share.id)).toBeNull();
    });

    it('a head timeout fails the share', async () => {
      const socket = await daemon();
      const res = await create({ runId, format: 'mp4' }).expect(202);
      const prepare = await socket.nextShare();
      socket.send({
        type: 'share.prepared',
        requestId: prepare.requestId,
        chapters: [],
        posterSize: POSTER.length,
      });
      await socket.nextOpen();
      t.clock.advance(HEAD_TIMEOUT_MS);
      t.app.get(VideoRelay).tick();
      const share = await settled(res.body.id, 'failed');
      expect(share.failure).toBe('runner-timeout');
      expect(await filesOf(share.id)).toBeNull();
    });

    it('a dropped socket mid-file fails the share and leaves no .part', async () => {
      const socket = await daemon();
      const res = await create({ runId, format: 'mp4' }).expect(202);
      const prepare = await socket.nextShare();
      socket.send({
        type: 'share.prepared',
        requestId: prepare.requestId,
        chapters: [],
        posterSize: POSTER.length,
      });
      const poster = await socket.nextOpen();
      socket.serve(poster.streamId, POSTER);
      const render = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: render.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });
      socket.sendChunk(render.streamId, FILE.subarray(0, 1000));
      await socket.roundTrip();
      await eventually(async () =>
        ((await filesOf(res.body.id)) ?? []).includes('file.mp4.part'),
      );
      socket.ws.terminate();
      const share = await settled(res.body.id, 'failed');
      expect(share.failure).toBe('runner-offline');
      expect(await filesOf(share.id)).toBeNull();
    });
  });

  describe('extend', () => {
    it('adds 30 days, never beyond 90 days from now', async () => {
      const id = await ready();
      const start = t.clock.now().getTime();
      const extend = () =>
        request(http).post(`/shares/${id}/extend`).set('Cookie', alice.cookie);

      const once = await extend().expect(200);
      expect(new Date(once.body.expiresAt).getTime()).toBe(start + 60 * DAY_MS);
      const twice = await extend().expect(200);
      expect(new Date(twice.body.expiresAt).getTime()).toBe(
        start + 90 * DAY_MS,
      );
      const capped = await extend().expect(409);
      expect(capped.body).toEqual({ error: 'at-max-expiry' });

      t.clock.advance(10 * DAY_MS);
      const later = await extend().expect(200);
      expect(new Date(later.body.expiresAt).getTime()).toBe(
        start + 100 * DAY_MS,
      );
    });
  });

  describe('authorization', () => {
    it('hides every share of another account', async () => {
      const id = await ready();
      for (const call of [
        request(http).get(`/shares/${id}`),
        request(http).post(`/shares/${id}/extend`),
        request(http).delete(`/shares/${id}`),
      ]) {
        const res = await call.set('Cookie', bob.cookie).expect(404);
        expect(res.body).toEqual({ error: 'not-found' });
      }
      const list = await request(http)
        .get('/shares')
        .set('Cookie', bob.cookie)
        .expect(200);
      expect(list.body.shares).toEqual([]);
      const res = await create({ runId, format: 'webm' }, bob.cookie).expect(
        404,
      );
      expect(res.body).toEqual({ error: 'not-found' });
      expect(await t.prisma.share.count({ where: { id } })).toBe(1);
    });

    it('lets a machine share only the runs it reported', async () => {
      await daemon();
      const second = await pair(http, alice, 'Desktop');
      const bobs = await pair(http, bob, 'Bob laptop');
      const viaRunner = (by: Paired, body: Record<string, unknown>) =>
        request(http)
          .post('/runner/shares')
          .set('Authorization', `Bearer ${by.token}`)
          .send(body);

      await viaRunner(bobs, { runId, format: 'mp4' }).expect(404);
      await viaRunner(second, { runId, format: 'mp4' }).expect(404);
      const res = await viaRunner(machine, { runId, format: 'mp4' }).expect(
        202,
      );
      expect(res.body.status).toBe('uploading');

      const read = (by: Paired) =>
        request(http)
          .get(`/runner/shares/${res.body.id}`)
          .set('Authorization', `Bearer ${by.token}`);
      await read(machine).expect(200);
      await read(second).expect(404);
      await read(bobs).expect(404);
    });
  });

  describe('deletes', () => {
    it('revokes a share: row and directory', async () => {
      const id = await ready();
      await request(http)
        .delete(`/shares/${id}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      expect(await t.prisma.share.count({ where: { id } })).toBe(0);
      expect(await filesOf(id)).toBeNull();
      await request(http)
        .delete(`/shares/${id}`)
        .set('Cookie', alice.cookie)
        .expect(404);
    });

    it('a run delete takes its shares and their files', async () => {
      const id = await ready();
      await request(http)
        .delete(`/runs/${runId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      expect(await t.prisma.share.count({ where: { id } })).toBe(0);
      expect(await filesOf(id)).toBeNull();
    });

    it('a bulk run delete takes their shares and files', async () => {
      const id = await ready();
      const { projectId } = await t.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      await request(http)
        .post(`/projects/${projectId}/runs/delete`)
        .set('Cookie', alice.cookie)
        .send({ runIds: [runId] })
        .expect(200);
      expect(await t.prisma.share.count({ where: { id } })).toBe(0);
      expect(await filesOf(id)).toBeNull();
    });

    it('a project delete takes its shares and files', async () => {
      const id = await ready();
      const { projectId } = await t.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      await request(http)
        .delete(`/projects/${projectId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      expect(await t.prisma.share.count({ where: { id } })).toBe(0);
      expect(await filesOf(id)).toBeNull();
    });

    it('an account delete takes its shares and files', async () => {
      const id = await ready();
      await request(http)
        .delete('/me')
        .set('Cookie', alice.cookie)
        .send({ email: alice.user.email })
        .expect(204);
      expect(await t.prisma.share.count({ where: { id } })).toBe(0);
      expect(await filesOf(id)).toBeNull();
    });

    it('deleting the run files on the machine leaves the share', async () => {
      const id = await ready();
      const socket = sockets[0];
      const deleting = request(http)
        .delete(`/runs/${runId}/artifacts`)
        .set('Cookie', alice.cookie)
        .then((res) => res.status);
      const ask = await socket.nextDelete();
      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      expect(await deleting).toBe(204);
      expect((await shareOf(id)).status).toBe('ready');
      expect(await filesOf(id)).toEqual(['file.mp4', 'poster.jpg']);
    });
  });

  describe('sweeper', () => {
    /** A share row with a directory, as an upload would have left it. */
    async function seed(
      format: string,
      fields: {
        status?: 'uploading' | 'ready';
        expiresAt?: Date;
        createdAt?: Date;
      },
      files: string[],
    ): Promise<string> {
      const share = await t.prisma.share.create({
        data: {
          token: generateToken(),
          userId: alice.user.id,
          runId,
          format,
          title: TITLE,
          status: fields.status ?? 'ready',
          expiresAt:
            fields.expiresAt ?? new Date(t.clock.now().getTime() + DAY_MS),
          ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
        },
      });
      await mkdir(join(dir, share.id), { recursive: true });
      for (const name of files) {
        await writeFile(join(dir, share.id, name), 'x');
      }
      return share.id;
    }

    it('deletes expired and orphaned files, fails stale uploads, marks lost', async () => {
      const now = t.clock.now().getTime();
      const expired = await seed('mp4', { expiresAt: new Date(now - 1000) }, [
        'file.mp4',
        'poster.jpg',
      ]);
      const stale = await seed(
        'webm',
        { status: 'uploading', createdAt: new Date(now - 16 * 60 * 1000) },
        ['file.webm.part'],
      );
      const lost = await seed('gif', {}, ['poster.jpg']);
      const orphan = 'cl0rphan0000000000000000';
      await mkdir(join(dir, orphan));
      await writeFile(join(dir, 'README'), 'not a share');

      const sweeper = new ShareSweeper(
        t.prisma,
        t.app.get(ShareStorage),
        t.clock,
      );
      await sweeper.sweep(true);

      expect(await t.prisma.share.count({ where: { id: expired } })).toBe(0);
      expect(await filesOf(expired)).toBeNull();
      expect(
        await t.prisma.share.findUniqueOrThrow({ where: { id: stale } }),
      ).toMatchObject({ status: 'failed', failure: 'timed-out' });
      expect(await filesOf(stale)).toBeNull();
      expect(
        (await t.prisma.share.findUniqueOrThrow({ where: { id: lost } }))
          .status,
      ).toBe('lost');
      expect(await filesOf(orphan)).toBeNull();
      expect(await readdir(dir)).toContain('README');
    });

    it('marks nothing lost outside the boot pass', async () => {
      const lost = await seed('gif', {}, []);
      const sweeper = new ShareSweeper(
        t.prisma,
        t.app.get(ShareStorage),
        t.clock,
      );
      await sweeper.sweep(false);
      expect(
        (await t.prisma.share.findUniqueOrThrow({ where: { id: lost } }))
          .status,
      ).toBe('ready');
    });
  });

  describe('logging', () => {
    it('never logs the token, the password, the title or the description', async () => {
      const lines: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => {
          lines.push(String(message));
        });
      try {
        const socket = await daemon();
        const res = await create({
          runId,
          format: 'mp4',
          password: PASSWORD,
        }).expect(202);
        await serveShare(socket);
        await settled(res.body.id, 'ready');
        await request(http)
          .post(`/shares/${res.body.id}/extend`)
          .set('Cookie', alice.cookie)
          .expect(200);
        await request(http)
          .delete(`/shares/${res.body.id}`)
          .set('Cookie', alice.cookie)
          .expect(204);

        const row = lines.join('\n');
        expect(row).toContain('share.create');
        expect(row).toContain('share.upload');
        expect(row).toContain('share.delete');
        const token = (res.body.url as string).split('/').pop() ?? '';
        for (const secret of [token, PASSWORD, TITLE, DESCRIPTION]) {
          expect(row).not.toContain(secret);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });
});
