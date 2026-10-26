import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request, { type Test } from 'supertest';
import type { App } from 'supertest/types';
import { LaunchesService } from '../launches/launches.service';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { eventually, TestSocket } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { CheckScheduler } from './schedules/check-scheduler';

const ROOT = '/home/alice/shop';
const SCENARIO = 'demoflow/checkout.demo.json';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// The fake clock starts at 2026-10-20T12:00:00Z; this slot is five minutes on.
const DAILY = { cadence: 'daily', at: '12:05', timeZone: 'UTC' };

describe('check schedules (integration)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  let projectId: string;
  let bobProjectId: string;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice, 'Laptop');
    projectId = (await report(machine, 'passed')).projectId;
    const bobMachine = await pair(http, bob, 'Desktop');
    bobProjectId = (await report(bobMachine, 'failed', '/home/bob/blog'))
      .projectId;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(
    on: Paired,
    status: 'passed' | 'failed',
    rootPath = ROOT,
    scenarioPath = SCENARIO,
    kind?: 'check',
  ): Promise<{ projectId: string; runId: string }> {
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${on.token}`)
      .send({
        rootPath,
        projectName: 'shop',
        scenarioName: 'Checkout',
        scenarioPath,
        status,
        startedAt: t.clock.now().toISOString(),
        durationMs: 12_345,
        formats: ['mp4'],
        cliVersion: '0.4.0',
        ...(kind && { kind }),
      })
      .expect(201);
    return res.body;
  }

  /** A daemon on `machine`; `checks` is what its `launches.sync` says, null for none. */
  async function daemon(checks: boolean | null = true): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      machine.token,
    );
    sockets.push(socket);
    socket.sync([], undefined, undefined, checks ?? undefined);
    await socket.roundTrip();
    return socket;
  }

  function put(body: unknown, cookie = alice.cookie, id = projectId): Test {
    return request(http)
      .put(`/projects/${id}/schedule`)
      .set('Cookie', cookie)
      .send(body as object);
  }

  function schedule(cookie = alice.cookie, id = projectId): Test {
    return request(http).get(`/projects/${id}/schedule`).set('Cookie', cookie);
  }

  function tick(): Promise<void> {
    return t.app.get(CheckScheduler).tick();
  }

  /** The `check.start`s the socket got and nobody consumed. */
  async function checkStarts(socket: TestSocket): Promise<number> {
    await socket.roundTrip();
    return socket.received.filter((m) => m.type === 'check.start').length;
  }

  describe('authorization', () => {
    it('answers 404 for another user’s project on every route', async () => {
      await put(DAILY, alice.cookie, bobProjectId).expect(404);
      await schedule(alice.cookie, bobProjectId).expect(404);
      await request(http)
        .delete(`/projects/${bobProjectId}/schedule`)
        .set('Cookie', alice.cookie)
        .expect(404);
      await request(http)
        .get(`/projects/${bobProjectId}/health`)
        .set('Cookie', alice.cookie)
        .expect(404);
      await request(http)
        .get('/projects/not-a-project/schedule')
        .set('Cookie', alice.cookie)
        .expect(404);
    });

    it('needs a session', async () => {
      await request(http).get(`/projects/${projectId}/schedule`).expect(401);
      await request(http).get('/checks/stale').expect(401);
    });

    it('never shows another user’s stale scenarios', async () => {
      await report(machine, 'failed');
      const res = await request(http)
        .get('/checks/stale')
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(res.body).toEqual([
        {
          projectId,
          projectName: 'shop',
          scenarioPath: SCENARIO,
          scenarioName: 'Checkout',
          since: t.clock.now().toISOString(),
          lastRunId: expect.any(String),
        },
      ]);
      const projects = await request(http)
        .get('/projects')
        .set('Cookie', bob.cookie)
        .expect(200);
      expect(
        projects.body.projects.map((p: { id: string; staleCount: number }) => [
          p.id,
          p.staleCount,
        ]),
      ).toEqual([[bobProjectId, 1]]);
    });
  });

  describe('PUT /projects/:id/schedule', () => {
    it('stores the site schedule and computes the next slot', async () => {
      const res = await put({
        ...DAILY,
        exclude: ['demoflow/slow.demo.json'],
      }).expect(200);
      expect(res.body).toEqual({
        source: 'site',
        cadence: 'daily',
        weekday: null,
        at: '12:05',
        timeZone: 'UTC',
        exclude: ['demoflow/slow.demo.json'],
        pausedReason: null,
        nextDueAt: '2026-10-20T12:05:00.000Z',
        lastPassAt: null,
      });
      const read = await schedule().expect(200);
      expect(read.body).toEqual({
        site: res.body,
        config: null,
        machine: {
          id: machine.runnerId,
          name: 'Laptop',
          online: false,
          zone: null,
        },
      });
    });

    it('keeps weekday for weekly only', async () => {
      const res = await put({
        cadence: 'weekly',
        weekday: 'mon',
        at: '09:00',
        timeZone: 'Europe/Berlin',
      }).expect(200);
      expect(res.body).toMatchObject({
        weekday: 'mon',
        nextDueAt: '2026-10-26T08:00:00.000Z',
      });
    });

    it.each([
      ['weekly without a weekday', { ...DAILY, cadence: 'weekly' }],
      ['a weekday without weekly', { ...DAILY, weekday: 'mon' }],
      ['an unknown weekday', { ...DAILY, cadence: 'weekly', weekday: 'mo' }],
      ['an unknown cadence', { ...DAILY, cadence: 'hourly' }],
      ['at 25:00', { ...DAILY, at: '25:00' }],
      ['at 9:00', { ...DAILY, at: '9:00' }],
      ['an unknown zone', { ...DAILY, timeZone: 'Mars/Olympus' }],
      ['no zone', { cadence: 'daily', at: '12:05' }],
      [
        '101 excludes',
        {
          ...DAILY,
          exclude: Array.from(
            { length: 101 },
            (_, i) => `demoflow/s${i}.demo.json`,
          ),
        },
      ],
      ['an exclude that is not a scenario id', { ...DAILY, exclude: ['../x'] }],
      ['an unknown key', { ...DAILY, machine: 'other' }],
    ])('refuses %s with 400', async (_, body) => {
      await put(body).expect(400);
    });

    it('is 409 no-machine when the project has no machine', async () => {
      await t.prisma.project.update({
        where: { id: projectId },
        data: { runnerId: null },
      });
      const res = await put(DAILY).expect(409);
      expect(res.body.error).toBe('no-machine');
    });

    it('is 409 config-schedule when the config has one', async () => {
      const socket = await daemon();
      syncSchedule(socket, { cadence: 'daily', at: '08:00' });
      await eventually(async () => (await configRow()) !== null);
      const res = await put(DAILY).expect(409);
      expect(res.body.error).toBe('config-schedule');
    });

    it('DELETE removes the site schedule', async () => {
      await put(DAILY).expect(200);
      await request(http)
        .delete(`/projects/${projectId}/schedule`)
        .set('Cookie', alice.cookie)
        .expect(204);
      const res = await schedule().expect(200);
      expect(res.body.site).toBeNull();
    });
  });

  function syncSchedule(
    socket: TestSocket,
    synced: Record<string, unknown> | null,
    zone = 'Europe/Kyiv',
  ): void {
    socket.send({
      type: 'schedules.sync',
      zone,
      projects: [
        { rootPath: ROOT, schedule: synced },
        { rootPath: '/home/alice/unknown', schedule: synced },
      ],
    });
  }

  function configRow() {
    return t.prisma.checkSchedule.findUnique({
      where: { projectId_source: { projectId, source: 'config' } },
    });
  }

  function siteRow() {
    return t.prisma.checkSchedule.findUnique({
      where: { projectId_source: { projectId, source: 'site' } },
    });
  }

  describe('schedules.sync', () => {
    it('creates the config row and pauses the site row; null lifts it', async () => {
      await put(DAILY).expect(200);
      const socket = await daemon();
      syncSchedule(socket, {
        cadence: 'weekly',
        weekday: 'fri',
        at: '18:30',
        exclude: [SCENARIO],
      });
      await eventually(async () => (await configRow()) !== null);
      const paused = await schedule().expect(200);
      expect(paused.body.config).toMatchObject({
        source: 'config',
        cadence: 'weekly',
        weekday: 'fri',
        at: '18:30',
        timeZone: 'Europe/Kyiv',
        exclude: [SCENARIO],
        pausedReason: null,
      });
      expect(paused.body.site).toMatchObject({
        pausedReason: 'config-schedule',
        nextDueAt: null,
      });
      expect(paused.body.machine).toMatchObject({
        online: true,
        zone: 'Europe/Kyiv',
      });
      // A project the server does not know is ignored.
      expect(await t.prisma.checkSchedule.count({ where: { projectId } })).toBe(
        2,
      );

      // The daemon runs config schedules; the API sends nothing for them.
      t.clock.advance(DAY);
      await tick();
      expect(await checkStarts(socket)).toBe(0);

      syncSchedule(socket, null);
      await eventually(async () => (await configRow()) === null);
      const lifted = await schedule().expect(200);
      expect(lifted.body.site).toMatchObject({ pausedReason: null });
      // Lifting does not catch up the slots the daemon owned.
      await tick();
      expect(await checkStarts(socket)).toBe(0);
    });

    it('refuses a sync with an unknown zone', async () => {
      const socket = await daemon();
      syncSchedule(socket, { cadence: 'daily', at: '08:00' }, 'Mars/Olympus');
      await socket.roundTrip();
      expect(await configRow()).toBeNull();
    });
  });

  describe('the scheduler', () => {
    it('sends one check.start for a due slot, and never a second', async () => {
      await put({ ...DAILY, exclude: [SCENARIO] }).expect(200);
      const socket = await daemon();
      await tick();
      expect(await checkStarts(socket)).toBe(0);

      t.clock.advance(5 * MINUTE);
      await tick();
      const ask = await socket.nextLaunch('check.start');
      expect(ask).toEqual({
        type: 'check.start',
        requestId: ask.requestId,
        rootPath: ROOT,
        exclude: [SCENARIO],
      });
      expect((await siteRow())?.lastSlotAt?.toISOString()).toBe(
        '2026-10-20T12:05:00.000Z',
      );
      socket.send({ type: 'check.started', requestId: ask.requestId });
      await socket.roundTrip();

      const launch = await request(http)
        .get(`/projects/${projectId}/launch`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(launch.body.launch).toMatchObject({
        id: ask.requestId,
        kind: 'check',
        scenarioId: null,
        state: 'running',
        passed: null,
        failed: null,
      });

      socket.send({
        type: 'check.finished',
        requestId: ask.requestId,
        passed: 3,
        failed: 1,
      });
      await socket.roundTrip();
      const done = await request(http)
        .get(`/projects/${projectId}/launch`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(done.body.launch).toMatchObject({
        kind: 'check',
        state: 'failed',
        passed: 3,
        failed: 1,
      });

      t.clock.advance(MINUTE);
      await tick();
      await tick();
      expect(await checkStarts(socket)).toBe(0);
    });

    it('sends one pass after three slots missed while offline', async () => {
      await put(DAILY).expect(200);
      t.clock.advance(3 * DAY);
      await tick();
      const socket = await daemon();
      await tick();
      await socket.nextLaunch('check.start');
      await tick();
      expect(await checkStarts(socket)).toBe(0);
      expect((await siteRow())?.lastSlotAt?.toISOString()).toBe(
        '2026-10-22T12:05:00.000Z',
      );
    });

    it('waits for a busy machine’s launch to end', async () => {
      await put(DAILY).expect(200);
      const socket = await daemon();
      const pending = request(http)
        .post(`/projects/${projectId}/launch`)
        .set('Cookie', alice.cookie)
        .send({ scenarioId: SCENARIO })
        .then((res) => res);
      const run = await socket.nextLaunch('run.start');
      socket.send({
        type: 'run.started',
        requestId: run.requestId,
        scenarioName: 'Checkout',
      });
      await pending;

      t.clock.advance(5 * MINUTE);
      await tick();
      expect(await checkStarts(socket)).toBe(0);

      socket.send({
        type: 'run.finished',
        requestId: run.requestId,
        outcome: 'failed',
        runId: null,
      });
      const launches = t.app.get(LaunchesService);
      await eventually(() => !launches.isBusy(machine.runnerId));
      await tick();
      await socket.nextLaunch('check.start');
    });

    it('owes the slot again when the machine answers busy', async () => {
      await put(DAILY).expect(200);
      const socket = await daemon();
      t.clock.advance(5 * MINUTE);
      await tick();
      const ask = await socket.nextLaunch('check.start');
      socket.send({
        type: 'check.error',
        requestId: ask.requestId,
        code: 'busy',
      });
      // Back to the slot PUT started from: yesterday's.
      await eventually(
        async () =>
          (await siteRow())?.lastSlotAt?.toISOString() ===
          '2026-10-19T12:05:00.000Z',
      );
      await tick();
      await socket.nextLaunch('check.start');
    });

    it('pauses with cli-too-old and never sends check.start without checks: true', async () => {
      await put(DAILY).expect(200);
      const socket = await daemon(null);
      t.clock.advance(5 * MINUTE);
      await tick();
      expect(await checkStarts(socket)).toBe(0);
      const res = await schedule().expect(200);
      expect(res.body.site).toMatchObject({
        pausedReason: 'cli-too-old',
        nextDueAt: null,
      });

      // The upgraded daemon replaces the socket and gets the slot it missed.
      const upgraded = await daemon(true);
      await tick();
      await upgraded.nextLaunch('check.start');
      expect((await siteRow())?.pausedReason).toBeNull();
    });

    it('pauses with no-machine when the project lost its machine', async () => {
      await put(DAILY).expect(200);
      await t.prisma.project.update({
        where: { id: projectId },
        data: { runnerId: null },
      });
      await tick();
      expect((await siteRow())?.pausedReason).toBe('no-machine');
      const res = await schedule().expect(200);
      expect(res.body.machine).toBeNull();
    });
  });

  describe('the stale state', () => {
    function health(): Test {
      return request(http)
        .get(`/projects/${projectId}/health`)
        .set('Cookie', alice.cookie);
    }

    it('flips on a failure, keeps since on a second, flips back on a pass', async () => {
      const passedAt = t.clock.now().toISOString();
      const first = await health().expect(200);
      expect(first.body).toEqual([
        {
          scenarioPath: SCENARIO,
          scenarioName: 'Checkout',
          state: 'passed',
          since: passedAt,
          lastRunId: expect.any(String),
        },
      ]);

      t.clock.advance(MINUTE);
      const failedAt = t.clock.now().toISOString();
      const failed = await report(machine, 'failed', ROOT, SCENARIO, 'check');
      expect((await health()).body[0]).toMatchObject({
        state: 'failed',
        since: failedAt,
        lastRunId: failed.runId,
      });

      t.clock.advance(MINUTE);
      const again = await report(machine, 'failed');
      expect((await health()).body[0]).toMatchObject({
        state: 'failed',
        since: failedAt,
        lastRunId: again.runId,
      });

      // The check run is the schedule's last pass.
      await put(DAILY).expect(200);
      expect((await schedule()).body.site.lastPassAt).toBe(failedAt);

      t.clock.advance(MINUTE);
      const fixedAt = t.clock.now().toISOString();
      const fixed = await report(machine, 'passed');
      expect((await health()).body[0]).toMatchObject({
        state: 'passed',
        since: fixedAt,
        lastRunId: fixed.runId,
      });
    });

    it('ignores a report older than the state', async () => {
      t.clock.advance(-MINUTE);
      await report(machine, 'failed');
      expect((await health()).body[0]).toMatchObject({ state: 'passed' });
    });
  });

  describe('the migration backfill', () => {
    /** The backfill's `SELECT`, as the migration runs it, for one project. */
    function backfill(id: string) {
      const sql = readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261028090000_check_schedules/migration.sql',
        ),
        'utf8',
      );
      const select = sql
        .slice(
          sql.indexOf('SELECT', sql.indexOf('INSERT INTO "ScenarioHealth"')),
        )
        .trim()
        .replace(/;$/, '');
      return t.prisma.$queryRawUnsafe<
        { scenarioPath: string; status: string; since: Date; id: string }[]
      >(
        `SELECT b."scenarioPath", b."status", b."since", b."id"
         FROM (${select}) AS b("projectId", "scenarioPath", "status", "since", "id")
         WHERE b."projectId" = $1 ORDER BY b."scenarioPath"`,
        id,
      );
    }

    it('gives each scenario the state of its latest run', async () => {
      t.clock.advance(MINUTE);
      const failedAt = t.clock.now();
      await report(machine, 'failed');
      t.clock.advance(MINUTE);
      const last = await report(machine, 'failed');
      const other = await report(
        machine,
        'passed',
        ROOT,
        'demoflow/signup.demo.json',
      );
      expect(await backfill(projectId)).toEqual([
        {
          scenarioPath: SCENARIO,
          status: 'failed',
          since: failedAt,
          id: last.runId,
        },
        {
          scenarioPath: 'demoflow/signup.demo.json',
          status: 'passed',
          since: t.clock.now(),
          id: other.runId,
        },
      ]);
      // And the rows the reports wrote agree with it.
      const rows = await t.prisma.scenarioHealth.findMany({
        where: { projectId },
        orderBy: { scenarioPath: 'asc' },
      });
      expect(
        rows.map((row) => ({
          scenarioPath: row.scenarioPath,
          status: row.state,
          since: row.since,
          id: row.lastRunId,
        })),
      ).toEqual(await backfill(projectId));
    });
  });
});
