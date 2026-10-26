import request from 'supertest';
import type { App } from 'supertest/types';
import {
  insertRunners,
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { RUNS_PAGE_SIZE } from './projects.service';

const ROOT = '/home/alice/shop';

describe('projects (integration)', () => {
  let t: TestApp;
  let http: App;
  let alice: SignedIn;
  let bob: SignedIn;
  let laptop: Paired;

  beforeEach(async () => {
    t = await createTestApp();
    http = t.app.getHttpServer();
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    laptop = await pair(http, alice, 'Laptop');
  });

  afterEach(async () => {
    await t.app.close();
  });

  function runReport(overrides: Record<string, unknown> = {}) {
    return {
      rootPath: ROOT,
      projectName: 'shop',
      scenarioName: 'checkout',
      scenarioPath: 'demos/checkout.yaml',
      status: 'passed',
      startedAt: t.clock.now().toISOString(),
      durationMs: 12_345,
      formats: ['mp4', 'gif'],
      cliVersion: '0.4.0',
      ...overrides,
    };
  }

  function report(token: string, body: Record<string, unknown> = runReport()) {
    return request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function list(cookie: string) {
    return request(http).get('/projects').set('Cookie', cookie);
  }

  function create(cookie: string, name: string) {
    return request(http).post('/projects').set('Cookie', cookie).send({ name });
  }

  function patch(cookie: string, id: string, body: Record<string, unknown>) {
    return request(http)
      .patch(`/projects/${id}`)
      .set('Cookie', cookie)
      .send(body);
  }

  function runs(cookie: string, id: string, cursor?: string) {
    return request(http)
      .get(`/projects/${id}/runs`)
      .query(cursor === undefined ? {} : { cursor })
      .set('Cookie', cookie);
  }

  describe('the run report', () => {
    it('upserts the project and adds a run', async () => {
      const res = await report(laptop.token).expect(201);

      const [project] = (await list(alice.cookie).expect(200)).body.projects;
      expect(res.body).toEqual({
        projectId: project.id,
        runId: expect.any(String),
      });
      expect(project).toEqual({
        id: res.body.projectId,
        name: 'shop',
        rootPath: ROOT,
        runner: { id: laptop.runnerId, name: 'Laptop' },
        runCount: 1,
        staleCount: 0,
        lastRun: {
          id: res.body.runId,
          scenarioName: 'checkout',
          scenarioPath: 'demos/checkout.yaml',
          status: 'passed',
          startedAt: t.clock.now().toISOString(),
          durationMs: 12_345,
          formats: ['mp4', 'gif'],
          failedStep: null,
          cliVersion: '0.4.0',
          artifactsDeletedAt: null,
          kind: null,
        },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('reuses the project for a second report from the same folder', async () => {
      const first = await report(laptop.token).expect(201);
      t.clock.advance(60_000);
      const second = await report(
        laptop.token,
        runReport({
          projectName: 'renamed in config',
          status: 'failed',
          failedStep: 3,
          formats: [],
          startedAt: t.clock.now().toISOString(),
        }),
      ).expect(201);

      expect(second.body.projectId).toBe(first.body.projectId);
      const { projects } = (await list(alice.cookie).expect(200)).body;
      expect(projects).toEqual([
        expect.objectContaining({
          name: 'shop',
          runCount: 2,
          staleCount: 1,
          lastRun: expect.objectContaining({
            id: second.body.runId,
            status: 'failed',
            failedStep: 3,
            formats: [],
          }),
        }),
      ]);
    });

    it('creates another project for another folder, or another machine', async () => {
      const desktop = await pair(http, alice, 'Desktop');
      const a = await report(laptop.token).expect(201);
      const b = await report(
        laptop.token,
        runReport({ rootPath: '/home/alice/blog' }),
      ).expect(201);
      const c = await report(desktop.token).expect(201);

      expect(
        new Set([a.body.projectId, b.body.projectId, c.body.projectId]).size,
      ).toBe(3);
      expect((await list(alice.cookie).expect(200)).body.projects).toHaveLength(
        3,
      );
    });

    it('accepts every format the CLI renders, the vertical and square exports too', async () => {
      const formats = [
        'mp4',
        'gif',
        'webm',
        'mp4-vertical',
        'gif-vertical',
        'webm-vertical',
        'mp4-square',
        'gif-square',
        'webm-square',
      ];
      await report(laptop.token, runReport({ formats })).expect(201);
      const { projects } = (await list(alice.cookie).expect(200)).body;
      expect(projects[0].lastRun.formats).toEqual(formats);
    });

    it('stores a check run with kind check, and an ordinary run with none (#360)', async () => {
      const check = await report(
        laptop.token,
        runReport({ kind: 'check', formats: [] }),
      ).expect(201);
      const ordinary = await report(laptop.token).expect(201);

      const rows = await t.prisma.run.findMany({
        where: { id: { in: [check.body.runId, ordinary.body.runId] } },
        select: { id: true, kind: true },
      });
      expect(new Map(rows.map((row) => [row.id, row.kind]))).toEqual(
        new Map([
          [check.body.runId, 'check'],
          [ordinary.body.runId, null],
        ]),
      );
      const page = (await runs(alice.cookie, check.body.projectId).expect(200))
        .body;
      expect(
        page.runs.map((run: { id: string; kind: string | null }) => [
          run.id,
          run.kind,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [check.body.runId, 'check'],
          [ordinary.body.runId, null],
        ]),
      );
    });

    it('refuses any kind but check', async () => {
      await report(laptop.token, runReport({ kind: 'video' })).expect(400);
      await report(laptop.token, runReport({ kind: null })).expect(201);
    });

    it('stores no field it was not given a column for', async () => {
      await report(laptop.token, {
        ...runReport(),
        stepValues: { password: 'hunter2' },
      }).expect(400);
    });

    it('validates the body', async () => {
      await report(laptop.token, runReport({ status: 'completed' })).expect(
        400,
      );
      await report(laptop.token, runReport({ formats: ['avi'] })).expect(400);
      await report(laptop.token, runReport({ formats: ['mp4', 'mp4'] })).expect(
        400,
      );
      await report(laptop.token, runReport({ failedStep: -1 })).expect(400);
      await report(laptop.token, runReport({ startedAt: 'yesterday' })).expect(
        400,
      );
      await report(laptop.token, runReport({ rootPath: '' })).expect(400);
    });

    it("rejects a revoked machine's report", async () => {
      await request(http)
        .delete(`/runners/${laptop.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);

      await report(laptop.token).expect(401);
      expect(
        await t.prisma.project.count({ where: { userId: alice.user.id } }),
      ).toBe(0);
    });

    it('requires a runner token, not a session', async () => {
      await request(http)
        .post('/runner/runs')
        .set('Cookie', alice.cookie)
        .send(runReport())
        .expect(401);
    });
  });

  describe('manual projects', () => {
    it('creates a project with no folder, which stays empty', async () => {
      const res = await create(alice.cookie, '  Marketing site ').expect(201);
      expect(res.body.project).toEqual(
        expect.objectContaining({
          name: 'Marketing site',
          rootPath: null,
          runner: null,
          runCount: 0,
          lastRun: null,
        }),
      );
      await create(alice.cookie, '   ').expect(400);
    });

    it('renames a project', async () => {
      const { body } = await create(alice.cookie, 'Draft').expect(201);
      const res = await patch(alice.cookie, body.project.id, {
        name: 'Final',
      }).expect(200);
      expect(res.body.project).toEqual(
        expect.objectContaining({ id: body.project.id, name: 'Final' }),
      );
    });

    it('binds a folder, and later reports land on it', async () => {
      const { body } = await create(alice.cookie, 'Shop').expect(201);
      await patch(alice.cookie, body.project.id, {
        runnerId: laptop.runnerId,
        rootPath: ROOT,
      }).expect(200);

      const reported = await report(laptop.token).expect(201);
      expect(reported.body.projectId).toBe(body.project.id);
      const [project] = (await list(alice.cookie).expect(200)).body.projects;
      expect(project).toEqual(
        expect.objectContaining({ name: 'Shop', runCount: 1 }),
      );
    });

    it('merges the automatic project when binding to its folder', async () => {
      const auto1 = await report(laptop.token).expect(201);
      t.clock.advance(1000);
      await report(
        laptop.token,
        runReport({ startedAt: t.clock.now().toISOString() }),
      ).expect(201);
      const { body } = await create(alice.cookie, 'Shop (manual)').expect(201);

      const res = await patch(alice.cookie, body.project.id, {
        runnerId: laptop.runnerId,
        rootPath: ROOT,
      }).expect(200);

      expect(res.body.project).toEqual(
        expect.objectContaining({
          id: body.project.id,
          name: 'Shop (manual)',
          rootPath: ROOT,
          runner: { id: laptop.runnerId, name: 'Laptop' },
          runCount: 2,
          staleCount: 0,
        }),
      );
      expect(
        await t.prisma.scenarioHealth.findMany({
          where: { projectId: body.project.id },
          select: { scenarioPath: true, state: true },
        }),
      ).toEqual([{ scenarioPath: 'demos/checkout.yaml', state: 'passed' }]);
      expect(
        await t.prisma.project.findUnique({
          where: { id: auto1.body.projectId },
        }),
      ).toBeNull();
      expect((await list(alice.cookie).expect(200)).body.projects).toHaveLength(
        1,
      );
    });

    it('binds runnerId and rootPath together or not at all', async () => {
      const { body } = await create(alice.cookie, 'Shop').expect(201);
      await patch(alice.cookie, body.project.id, {
        runnerId: laptop.runnerId,
      }).expect(400);
      await patch(alice.cookie, body.project.id, { rootPath: ROOT }).expect(
        400,
      );
    });

    it('refuses to bind a revoked machine', async () => {
      const { body } = await create(alice.cookie, 'Shop').expect(201);
      await request(http)
        .delete(`/runners/${laptop.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      await patch(alice.cookie, body.project.id, {
        runnerId: laptop.runnerId,
        rootPath: ROOT,
      }).expect(404);
    });

    it('deletes a project and its runs', async () => {
      const { body } = await report(laptop.token).expect(201);
      await request(http)
        .delete(`/projects/${body.projectId}`)
        .set('Cookie', alice.cookie)
        .expect(204);

      expect(await t.prisma.run.count({ where: { id: body.runId } })).toBe(0);
      expect((await list(alice.cookie).expect(200)).body.projects).toEqual([]);
      await request(http)
        .delete(`/projects/${body.projectId}`)
        .set('Cookie', alice.cookie)
        .expect(404);
    });

    it('shows "machine removed" once the machine is revoked', async () => {
      await report(laptop.token).expect(201);
      await request(http)
        .delete(`/runners/${laptop.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);

      const [project] = (await list(alice.cookie).expect(200)).body.projects;
      expect(project).toEqual(
        expect.objectContaining({ runner: null, rootPath: ROOT, runCount: 1 }),
      );
    });
  });

  describe('listing', () => {
    it('lists projects by newest activity first', async () => {
      const older = await report(laptop.token).expect(201);
      t.clock.advance(60_000);
      const { body: manual } = await create(alice.cookie, 'Fresh').expect(201);
      t.clock.advance(60_000);
      await report(
        laptop.token,
        runReport({ startedAt: t.clock.now().toISOString() }),
      ).expect(201);
      t.clock.advance(60_000);
      const blog = await report(
        laptop.token,
        runReport({
          rootPath: '/home/alice/blog',
          startedAt: new Date(t.clock.now().getTime() - 90_000).toISOString(),
        }),
      ).expect(201);

      const ids = (await list(alice.cookie).expect(200)).body.projects.map(
        (p: { id: string }) => p.id,
      );
      // The manual project's createdAt is the database's clock, not the fake one.
      expect(ids.filter((id: string) => id !== manual.project.id)).toEqual([
        older.body.projectId,
        blog.body.projectId,
      ]);
    });

    it('pages runs newest first, 50 at a time', async () => {
      const { body } = await report(laptop.token).expect(201);
      const total = RUNS_PAGE_SIZE + 5;
      await t.prisma.run.createMany({
        data: Array.from({ length: total - 1 }, (_, i) => ({
          projectId: body.projectId,
          runnerId: laptop.runnerId,
          scenarioName: `s${i}`,
          scenarioPath: `s${i}.yaml`,
          status: 'passed' as const,
          startedAt: new Date(t.clock.now().getTime() + (i + 1) * 1000),
          durationMs: 1,
          formats: ['mp4'],
          cliVersion: '0.4.0',
        })),
      });

      const first = await runs(alice.cookie, body.projectId).expect(200);
      expect(first.body.runs).toHaveLength(RUNS_PAGE_SIZE);
      expect(first.body.runs[0].scenarioName).toBe(`s${total - 2}`);
      expect(first.body.nextCursor).toBe(
        first.body.runs[RUNS_PAGE_SIZE - 1].id,
      );

      const second = await runs(
        alice.cookie,
        body.projectId,
        first.body.nextCursor,
      ).expect(200);
      expect(second.body.runs).toHaveLength(5);
      expect(second.body.runs[4].id).toBe(body.runId);
      expect(second.body.nextCursor).toBeNull();

      await runs(alice.cookie, body.projectId, 'nope').expect(400);
    });
  });

  describe('filtering runs by status', () => {
    function seed(projectId: string, status: 'passed' | 'failed', n: number) {
      return t.prisma.run.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          projectId,
          runnerId: laptop.runnerId,
          scenarioName: `${status}${i}`,
          scenarioPath: `${status}${i}.yaml`,
          status,
          startedAt: new Date(t.clock.now().getTime() + (i + 1) * 1000),
          durationMs: 1,
          formats: ['mp4'],
          cliVersion: '0.4.0',
        })),
      });
    }

    function filtered(cookie: string, id: string, query: object) {
      return request(http)
        .get(`/projects/${id}/runs`)
        .query(query)
        .set('Cookie', cookie);
    }

    it('returns only the requested status, newest first', async () => {
      const { body } = await report(laptop.token).expect(201);
      await seed(body.projectId, 'failed', 3);
      await seed(body.projectId, 'passed', 2);

      const failed = await filtered(alice.cookie, body.projectId, {
        status: 'failed',
      }).expect(200);
      expect(
        failed.body.runs.map((r: { scenarioName: string }) => r.scenarioName),
      ).toEqual(['failed2', 'failed1', 'failed0']);

      const passed = await filtered(alice.cookie, body.projectId, {
        status: 'passed',
      }).expect(200);
      expect(passed.body.runs).toHaveLength(3);
      expect(
        passed.body.runs.every(
          (r: { status: string }) => r.status === 'passed',
        ),
      ).toBe(true);

      const all = await runs(alice.cookie, body.projectId).expect(200);
      expect(all.body.runs).toHaveLength(6);
    });

    it('pages within a status', async () => {
      const { body } = await report(laptop.token).expect(201);
      await seed(body.projectId, 'failed', RUNS_PAGE_SIZE + 1);

      const first = await filtered(alice.cookie, body.projectId, {
        status: 'failed',
      }).expect(200);
      expect(first.body.runs).toHaveLength(RUNS_PAGE_SIZE);
      expect(first.body.nextCursor).not.toBeNull();

      const second = await filtered(alice.cookie, body.projectId, {
        status: 'failed',
        cursor: first.body.nextCursor,
      }).expect(200);
      expect(second.body.runs).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
    });

    it('rejects a cursor from another status', async () => {
      const { body } = await report(laptop.token).expect(201);
      const res = await filtered(alice.cookie, body.projectId, {
        status: 'failed',
        cursor: body.runId,
      }).expect(400);
      expect(res.body.message).toBe('Unknown cursor');
    });

    it('rejects an unknown or empty status, and 404s another account', async () => {
      const { body } = await report(laptop.token).expect(201);
      await filtered(alice.cookie, body.projectId, {
        status: 'running',
      }).expect(400);
      await filtered(alice.cookie, body.projectId, { status: '' }).expect(400);
      await filtered(bob.cookie, body.projectId, { status: 'failed' }).expect(
        404,
      );
    });
  });

  describe('authorization across accounts', () => {
    it("404s every call on another account's project", async () => {
      const { body } = await report(laptop.token).expect(201);
      const id = body.projectId;

      expect((await list(bob.cookie).expect(200)).body.projects).toEqual([]);
      await runs(bob.cookie, id).expect(404);
      await patch(bob.cookie, id, { name: 'mine now' }).expect(404);
      await request(http)
        .delete(`/projects/${id}`)
        .set('Cookie', bob.cookie)
        .expect(404);
      expect((await list(alice.cookie).expect(200)).body.projects[0].name).toBe(
        'shop',
      );
    });

    it("404s a bind to another account's machine", async () => {
      const [bobMachine] = await insertRunners(t, bob.user.id, 1);
      const { body } = await create(alice.cookie, 'Shop').expect(201);
      await patch(alice.cookie, body.project.id, {
        runnerId: bobMachine,
        rootPath: ROOT,
      }).expect(404);
    });

    it('requires a session', async () => {
      await request(http).get('/projects').expect(401);
    });
  });

  it('goes with the account: projects and runs cascade (#177)', async () => {
    const { body } = await report(laptop.token).expect(201);
    await t.prisma.user.delete({ where: { id: alice.user.id } });

    expect(
      await t.prisma.project.count({ where: { id: body.projectId } }),
    ).toBe(0);
    expect(await t.prisma.run.count({ where: { id: body.runId } })).toBe(0);
  });
});
