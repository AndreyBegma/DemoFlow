import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { RunnerConnections } from '../runner/runner-connections.service';
import {
  eventually,
  type LaunchRequest,
  TestSocket,
} from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import {
  CANCEL_TIMEOUT_MS,
  LAUNCH_RETENTION_MS,
  LaunchesService,
  LIST_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  RUN_TIMEOUT_MS,
  START_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
} from './launches.service';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT = '/home/alice/shop';
const SCENARIO = 'demoflow/checkout.demo.json';
const LAUNCH_TYPES = ['scenarios.list', 'run.start', 'run.cancel'];

describe('starting and cancelling a run from the website (integration)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  let projectId: string;
  let runId: string;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice, 'Laptop');
    ({ projectId, runId } = await report(machine));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(
    on: Paired,
    rootPath = ROOT,
  ): Promise<{ projectId: string; runId: string }> {
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${on.token}`)
      .send({
        rootPath,
        projectName: 'shop',
        scenarioName: 'checkout',
        scenarioPath: SCENARIO,
        status: 'passed',
        startedAt: t.clock.now().toISOString(),
        durationMs: 12_345,
        formats: ['mp4'],
        cliVersion: '0.4.0',
      })
      .expect(201);
    return res.body;
  }

  async function daemon(on = machine): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      on.token,
    );
    sockets.push(socket);
    return socket;
  }

  function service(): LaunchesService {
    return t.app.get(LaunchesService);
  }

  /** Moves the fake clock, then runs the sweep. */
  function sweep(ms: number): void {
    t.clock.advance(ms);
    service().tick();
  }

  // Each starts the request, so a test can answer as the daemon meanwhile.
  function list(cookie = alice.cookie, id = projectId): Promise<Response> {
    return request(http)
      .get(`/projects/${id}/scenarios`)
      .set('Cookie', cookie)
      .then((res) => res);
  }

  function start(
    body: unknown = { scenarioId: SCENARIO },
    cookie = alice.cookie,
    id = projectId,
  ): Promise<Response> {
    return request(http)
      .post(`/projects/${id}/launch`)
      .set('Cookie', cookie)
      .send(body as object)
      .then((res) => res);
  }

  function latest(cookie = alice.cookie, id = projectId): Promise<Response> {
    return request(http)
      .get(`/projects/${id}/launch`)
      .set('Cookie', cookie)
      .then((res) => res);
  }

  function cancel(cookie = alice.cookie, id = projectId): Promise<Response> {
    return request(http)
      .delete(`/projects/${id}/launch`)
      .set('Cookie', cookie)
      .then((res) => res);
  }

  /** A launch the machine said started; answers the `POST`. */
  async function running(
    socket: TestSocket,
  ): Promise<{ ask: LaunchRequest; res: Response }> {
    const pending = start();
    const ask = await socket.nextLaunch('run.start');
    socket.send({
      type: 'run.started',
      requestId: ask.requestId,
      scenarioName: 'Checkout',
    });
    const res = await pending;
    expect(res.status).toBe(202);
    return { ask, res };
  }

  async function launchState(): Promise<unknown> {
    return (await latest()).body.launch?.state;
  }

  /** Nothing reached the daemon: every frame before the round trip is in. */
  async function expectNothingSent(socket: TestSocket): Promise<void> {
    await socket.roundTrip();
    expect(
      socket.received.filter((m) => LAUNCH_TYPES.includes(m.type)),
    ).toEqual([]);
  }

  function online(): boolean {
    return t.app.get(RunnerConnections).isOnline(machine.runnerId);
  }

  /** The socket drops without a goodbye, and the server has noticed. */
  async function drop(socket: TestSocket): Promise<void> {
    socket.ws.terminate();
    await eventually(() => !online());
  }

  /** True once `promise` settled; for "not yet" checks. */
  function watch(promise: Promise<unknown>): () => boolean {
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    return () => settled;
  }

  describe('scenario list', () => {
    it('asks the machine with the project root and passes its answer on', async () => {
      const socket = await daemon();
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      expect(ask).toEqual({
        type: 'scenarios.list',
        requestId: expect.stringMatching(UUID_V4),
        rootPath: ROOT,
      });
      const scenarios = [
        { id: 'demoflow/a.demo.json', name: 'A' },
        { id: SCENARIO, name: 'Checkout' },
      ];
      socket.send({
        type: 'scenarios.listed',
        requestId: ask.requestId,
        scenarios,
        truncated: true,
        skipped: 2,
      });

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        scenarios,
        truncated: true,
        skipped: 2,
        runOptions: [],
      });
    });

    it.each([
      ['project-unknown', 409, 'project-unknown'],
      ['io', 502, 'runner-error'],
      ['something-new', 502, 'runner-error'],
    ])('answers scenarios.error %s with %i %s', async (code, status, error) => {
      const socket = await daemon();
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      socket.send({ type: 'scenarios.error', requestId: ask.requestId, code });

      const res = await pending;
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
    });
  });

  describe('start', () => {
    it('sends run.start and answers 202 with a running launch once it started', async () => {
      const socket = await daemon();
      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      expect(ask).toEqual({
        type: 'run.start',
        requestId: expect.stringMatching(UUID_V4),
        rootPath: ROOT,
        scenarioId: SCENARIO,
      });
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });

      const res = await pending;
      expect(res.status).toBe(202);
      const launch = {
        id: ask.requestId,
        scenarioId: SCENARIO,
        scenarioName: 'Checkout',
        state: 'running',
        startedAt: t.clock.now().toISOString(),
        finishedAt: null,
        runId: null,
        progress: null,
        formats: null,
      };
      expect(res.body).toEqual({ launch });
      expect((await latest()).body).toEqual({ launch });
    });

    it('answers GET with null before any launch', async () => {
      const res = await latest();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ launch: null });
    });

    it.each([
      ['a parent segment', { scenarioId: '../x.demo.json' }],
      ['a backslash', { scenarioId: 'demoflow/a\\b.demo.json' }],
      ['the wrong suffix', { scenarioId: 'demoflow/x.json' }],
      ['an absolute path', { scenarioId: '/abs/demoflow/x.demo.json' }],
      [
        '256 characters',
        {
          scenarioId: `demoflow/${'a'.repeat(256 - 'demoflow/.demo.json'.length)}.demo.json`,
        },
      ],
      ['no scenario id', {}],
      ['a number', { scenarioId: 7 }],
      ['another field', { scenarioId: SCENARIO, rootPath: '/etc' }],
    ])('400s %s and sends nothing', async (_label, body) => {
      const socket = await daemon();
      const res = await start(body);
      expect(res.status).toBe(400);
      await expectNothingSent(socket);
    });

    it.each([
      ['scenario-not-found', 404, 'scenario-not-found'],
      ['scenario-invalid', 422, 'scenario-invalid'],
      ['config-invalid', 422, 'config-invalid'],
      ['project-unknown', 409, 'project-unknown'],
      ['busy', 409, 'runner-busy'],
      ['reporting-off', 409, 'reporting-off'],
      ['options-invalid', 422, 'options-invalid'],
      ['io', 502, 'runner-error'],
      ['something-new', 502, 'runner-error'],
      ['constructor', 502, 'runner-error'],
    ])('answers run.error %s with %i %s and leaves no launch', async (code, status, error) => {
      const socket = await daemon();
      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      socket.send({ type: 'run.error', requestId: ask.requestId, code });

      const res = await pending;
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
      expect((await latest()).body).toEqual({ launch: null });
      // The machine is free again.
      await running(socket);
    });

    it('409s runner-busy for the same and another project on the machine, and sends nothing', async () => {
      const socket = await daemon();
      await running(socket);
      const other = await report(machine, '/home/alice/blog');

      for (const id of [projectId, other.projectId]) {
        const res = await start(undefined, alice.cookie, id);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'runner-busy' });
      }
      await expectNothingSent(socket);
    });

    it('409s runner-busy while the first launch is still starting', async () => {
      const socket = await daemon();
      const first = start();
      await socket.nextLaunch('run.start');
      const res = await start();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-busy' });
      await expectNothingSent(socket);
      socket.ws.terminate();
      expect((await first).status).toBe(503);
    });
  });

  describe('who may ask, and project state', () => {
    it("404s another account's project and an unknown one on every route, and sends nothing", async () => {
      const socket = await daemon();
      for (const [cookie, id] of [
        [bob.cookie, projectId],
        [alice.cookie, randomUUID()],
      ]) {
        for (const res of [
          await list(cookie, id),
          await start(undefined, cookie, id),
          await latest(cookie, id),
          await cancel(cookie, id),
        ]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ error: 'not-found' });
        }
      }
      await expectNothingSent(socket);
    });

    it('401s without a session', async () => {
      await request(http).get(`/projects/${projectId}/scenarios`).expect(401);
      await request(http)
        .post(`/projects/${projectId}/launch`)
        .send({ scenarioId: SCENARIO })
        .expect(401);
    });

    it('403s a foreign origin', async () => {
      await request(http)
        .post(`/projects/${projectId}/launch`)
        .set('Cookie', alice.cookie)
        .set('Origin', 'https://evil.example')
        .send({ scenarioId: SCENARIO })
        .expect(403);
    });

    it('409s project-unbound for a project without a root, and sends nothing', async () => {
      const socket = await daemon();
      const created = await request(http)
        .post('/projects')
        .set('Cookie', alice.cookie)
        .send({ name: 'blank' })
        .expect(201);
      const id = created.body.project.id;
      for (const res of [
        await list(alice.cookie, id),
        await start(undefined, alice.cookie, id),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'project-unbound' });
      }
      await expectNothingSent(socket);
    });

    it('503s runner-removed for a revoked machine', async () => {
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      for (const res of [await list(), await start()]) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'runner-removed' });
      }
    });

    it('503s runner-removed for a project without a machine, and sends nothing', async () => {
      const socket = await daemon();
      await t.prisma.project.update({
        where: { id: projectId },
        data: { runnerId: null },
      });
      for (const res of [await list(), await start()]) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'runner-removed' });
      }
      await expectNothingSent(socket);
    });

    it('503s runner-offline when the machine has no socket', async () => {
      for (const res of [await list(), await start()]) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'runner-offline' });
      }
    });
  });

  describe('timeouts', () => {
    it('answers the list 504 runner-timeout after 10 s and drops a late answer', async () => {
      const socket = await daemon();
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      const settled = watch(pending);
      sweep(LIST_TIMEOUT_MS - 1);
      await socket.roundTrip();
      expect(settled()).toBe(false);
      sweep(1);

      const res = await pending;
      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'runner-timeout' });

      socket.send({
        type: 'scenarios.listed',
        requestId: ask.requestId,
        scenarios: [],
        truncated: false,
        skipped: 0,
      });
      await socket.roundTrip();
      expect(online()).toBe(true);
    });

    it('answers the start 504 after 15 s, cancels it on the machine and drops a late run.started', async () => {
      const socket = await daemon();
      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      const settled = watch(pending);
      sweep(START_TIMEOUT_MS - 1);
      await socket.roundTrip();
      expect(settled()).toBe(false);
      sweep(1);

      const res = await pending;
      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'runner-timeout' });
      expect(await socket.nextLaunch('run.cancel')).toEqual({
        type: 'run.cancel',
        requestId: ask.requestId,
      });

      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      await socket.roundTrip();
      expect(online()).toBe(true);
      expect((await latest()).body).toEqual({ launch: null });
    });

    it('marks a running launch lost after 20 minutes without run.finished', async () => {
      const socket = await daemon();
      await running(socket);
      sweep(RUN_TIMEOUT_MS - 1);
      expect(await launchState()).toBe('running');
      sweep(1);
      const { launch } = (await latest()).body;
      expect(launch.state).toBe('lost');
      expect(launch.finishedAt).toBe(t.clock.now().toISOString());
    });
  });

  describe('cancel', () => {
    it('sends run.cancel once, answers cancelling, and run.finished cancelled ends it', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);

      const res = await cancel();
      expect(res.status).toBe(202);
      expect(res.body.launch).toMatchObject({
        id: ask.requestId,
        state: 'cancelling',
      });
      expect(await socket.nextLaunch('run.cancel')).toEqual({
        type: 'run.cancel',
        requestId: ask.requestId,
      });

      const again = await cancel();
      expect(again.status).toBe(202);
      expect(again.body.launch.state).toBe('cancelling');
      await expectNothingSent(socket);

      t.clock.advance(5000);
      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'cancelled',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'cancelled');
      expect((await latest()).body.launch).toMatchObject({
        finishedAt: t.clock.now().toISOString(),
        runId: null,
      });
    });

    it('keeps the real outcome of a run that finished before the kill', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await cancel();
      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'passed',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'passed');
    });

    it('marks a cancelling launch lost after 30 s without run.finished', async () => {
      const socket = await daemon();
      await running(socket);
      await cancel();
      sweep(CANCEL_TIMEOUT_MS - 1);
      expect(await launchState()).toBe('cancelling');
      sweep(1);
      expect(await launchState()).toBe('lost');
    });

    it('409s not-running with no launch, a starting one, or a finished one', async () => {
      const socket = await daemon();
      const none = await cancel();
      expect(none.status).toBe(409);
      expect(none.body).toEqual({ error: 'not-running' });

      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      expect((await cancel()).body).toEqual({ error: 'not-running' });
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      await pending;
      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'failed',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'failed');
      const finished = await cancel();
      expect(finished.status).toBe(409);
      expect(finished.body).toEqual({ error: 'not-running' });
      await expectNothingSent(socket);
    });
  });

  describe('socket close', () => {
    it('ends a pending list and a pending start with 503 runner-offline', async () => {
      const socket = await daemon();
      const listing = list();
      await socket.nextLaunch('scenarios.list');
      const starting = start();
      await socket.nextLaunch('run.start');
      socket.ws.terminate();

      for (const res of [await listing, await starting]) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'runner-offline' });
      }
      expect((await latest()).body).toEqual({ launch: null });
    });

    it('keeps a running launch running, and marks it lost 90 s after the close without a reconnect', async () => {
      const socket = await daemon();
      await running(socket);
      await drop(socket);
      expect(await launchState()).toBe('running');

      sweep(RECONNECT_GRACE_MS - 1);
      expect(await launchState()).toBe('running');
      sweep(1);
      const { launch } = (await latest()).body;
      expect(launch).toMatchObject({ state: 'lost', runId: null });
      expect(launch.finishedAt).toBe(t.clock.now().toISOString());
    });

    it('marks a cancelling launch lost when a socket replaces it and never syncs', async () => {
      const socket = await daemon();
      await running(socket);
      await cancel();
      await daemon();
      expect(await launchState()).toBe('cancelling');
      sweep(SYNC_TIMEOUT_MS);
      expect(await launchState()).toBe('lost');
    });
  });

  describe('reconnect (spec #284)', () => {
    it('reattaches a running launch the new socket syncs, and run.finished ends it', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await drop(socket);

      const later = await daemon();
      later.sync([ask.requestId]);
      await later.roundTrip();
      sweep(RECONNECT_GRACE_MS);
      expect(await launchState()).toBe('running');
      await expectNothingSent(later);

      later.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'passed',
        runId,
      });
      await eventually(async () => (await launchState()) === 'passed');
      expect((await latest()).body.launch.runId).toBe(runId);
    });

    it('keeps the 20-minute run timeout counting from run.started', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      sweep(RUN_TIMEOUT_MS - 60_000);
      await drop(socket);
      const later = await daemon();
      later.sync([ask.requestId]);
      await later.roundTrip();
      sweep(60_000);
      expect(await launchState()).toBe('lost');
    });

    it('marks a launch lost when the new socket syncs without it', async () => {
      const socket = await daemon();
      await running(socket);
      await drop(socket);

      const later = await daemon();
      later.sync([]);
      await later.roundTrip();
      expect((await latest()).body.launch).toMatchObject({
        state: 'lost',
        runId: null,
      });
    });

    it('marks a launch lost 10 s after a new socket that never syncs, and keeps the socket', async () => {
      const socket = await daemon();
      await running(socket);
      await drop(socket);

      await daemon();
      sweep(SYNC_TIMEOUT_MS - 1);
      expect(await launchState()).toBe('running');
      sweep(1);
      expect(await launchState()).toBe('lost');
      expect(online()).toBe(true);
    });

    it('keeps the grace from the first close across a reconnect that drops again', async () => {
      const socket = await daemon();
      await running(socket);
      await drop(socket);
      sweep(RECONNECT_GRACE_MS - 5000);
      await drop(await daemon());
      sweep(4999);
      expect(await launchState()).toBe('running');
      sweep(1);
      expect(await launchState()).toBe('lost');
    });

    it('sends run.cancel again for a cancelling launch it reattaches, and restarts its timeout', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await cancel();
      await socket.nextLaunch('run.cancel');
      await drop(socket);

      const later = await daemon();
      later.sync([ask.requestId]);
      expect(await later.nextLaunch('run.cancel')).toEqual({
        type: 'run.cancel',
        requestId: ask.requestId,
      });
      sweep(CANCEL_TIMEOUT_MS - 1);
      expect(await launchState()).toBe('cancelling');
      sweep(1);
      expect(await launchState()).toBe('lost');
    });

    it('cancels a detached launch without sending, and sends run.cancel once it is synced', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await drop(socket);

      const res = await cancel();
      expect(res.status).toBe(202);
      expect(res.body.launch.state).toBe('cancelling');
      // The cancel timeout waits for the machine; the grace does not.
      sweep(CANCEL_TIMEOUT_MS);
      expect(await launchState()).toBe('cancelling');

      const later = await daemon();
      await expectNothingSent(later);
      later.sync([ask.requestId]);
      await later.nextLaunch('run.cancel');
      later.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'cancelled',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'cancelled');
    });

    it('accepts run.finished from the new socket before its sync', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await drop(socket);

      const later = await daemon();
      later.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'failed',
        runId,
      });
      await eventually(async () => (await launchState()) === 'failed');
      later.sync([]);
      await later.roundTrip();
      sweep(SYNC_TIMEOUT_MS);
      expect((await latest()).body.launch).toMatchObject({
        state: 'failed',
        runId,
      });
    });

    it("ignores an unknown id and another machine's launch, and sends nothing", async () => {
      const desktop = await pair(http, alice, 'Desktop');
      const blog = await report(desktop, '/home/alice/blog');
      const other = await daemon(desktop);
      const pending = start(
        { scenarioId: SCENARIO },
        alice.cookie,
        blog.projectId,
      );
      const ask = await other.nextLaunch('run.start');
      other.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      expect((await pending).status).toBe(202);

      const socket = await daemon();
      socket.sync([randomUUID(), ask.requestId]);
      await expectNothingSent(socket);
      await expectNothingSent(other);
      expect(online()).toBe(true);
      expect((await latest()).body).toEqual({ launch: null });
      expect(
        (await latest(alice.cookie, blog.projectId)).body.launch.state,
      ).toBe('running');
    });

    it('drops a second sync on the same socket', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await drop(socket);

      const later = await daemon();
      later.sync([ask.requestId]);
      later.sync([]);
      await later.roundTrip();
      expect(online()).toBe(true);
      expect(await launchState()).toBe('running');
    });

    it('409s runner-busy while a detached launch awaits its sync and once reattached', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      await drop(socket);
      expect((await start()).body).toEqual({ error: 'runner-offline' });

      const later = await daemon();
      const awaiting = await start();
      expect(awaiting.status).toBe(409);
      expect(awaiting.body).toEqual({ error: 'runner-busy' });

      later.sync([ask.requestId]);
      await later.roundTrip();
      const reattached = await start();
      expect(reattached.status).toBe(409);
      expect(reattached.body).toEqual({ error: 'runner-busy' });
      await expectNothingSent(later);
    });
  });

  describe('finish', () => {
    async function finishWith(reported: string | null): Promise<unknown> {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'passed',
        runId: reported,
      });
      await eventually(async () => (await launchState()) === 'passed');
      return (await latest()).body.launch.runId;
    }

    it('keeps a run id of this project and machine', async () => {
      expect(await finishWith(runId)).toBe(runId);
    });

    it('drops a run id of another project on the machine', async () => {
      const other = await report(machine, '/home/alice/blog');
      expect(await finishWith(other.runId)).toBeNull();
    });

    it('drops a run id of this project from another machine', async () => {
      const desktop = await pair(http, alice, 'Desktop');
      await t.prisma.run.update({
        where: { id: runId },
        data: { runnerId: desktop.runnerId },
      });
      expect(await finishWith(runId)).toBeNull();
    });

    it('drops an unknown run id', async () => {
      expect(await finishWith('not-a-run')).toBeNull();
    });

    it('keeps a finished launch for 10 minutes', async () => {
      await finishWith(null);
      sweep(9 * 60 * 1000);
      expect(await launchState()).toBe('passed');
      sweep(LAUNCH_RETENTION_MS - 9 * 60 * 1000);
      expect((await latest()).body).toEqual({ launch: null });
    });
  });

  describe('progress (spec #301)', () => {
    async function progress(): Promise<unknown> {
      return (await latest()).body.launch?.progress;
    }

    it('returns null before the first frame, then the latest phase and step', async () => {
      const socket = await daemon();
      const { ask, res } = await running(socket);
      expect(res.body.launch.progress).toBeNull();
      expect(await progress()).toBeNull();

      socket.progress(ask.requestId, 'app');
      await socket.roundTrip();
      expect(await progress()).toEqual({
        phase: 'app',
        step: null,
        steps: null,
      });

      socket.progress(ask.requestId, 'steps', 3, 7);
      await socket.roundTrip();
      expect(await progress()).toEqual({ phase: 'steps', step: 3, steps: 7 });

      socket.progress(ask.requestId, 'rendering');
      await socket.roundTrip();
      expect(await progress()).toEqual({
        phase: 'rendering',
        step: null,
        steps: null,
      });
    });

    it('drops an inconsistent or invalid frame, keeps the previous progress and the socket', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.progress(ask.requestId, 'steps', 2, 5);
      socket.progress(ask.requestId, 'steps', 6, 5);
      socket.progress(ask.requestId, 'app', 1, 5);
      socket.progress(ask.requestId, 'steps', null, null);
      socket.progress(ask.requestId, 'steps', 0, 5);
      socket.progress(ask.requestId, 'verifying');
      await socket.roundTrip();
      expect(online()).toBe(true);
      expect(await progress()).toEqual({ phase: 'steps', step: 2, steps: 5 });
    });

    it('keeps a frame that arrives while starting and shows it once running', async () => {
      const socket = await daemon();
      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      socket.progress(ask.requestId, 'app');
      await socket.roundTrip();
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      const res = await pending;
      expect(res.body.launch.progress).toEqual({
        phase: 'app',
        step: null,
        steps: null,
      });
      expect(await progress()).toEqual({
        phase: 'app',
        step: null,
        steps: null,
      });
    });

    it('shows null while cancelling and once finished', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.progress(ask.requestId, 'steps', 4, 9);
      await socket.roundTrip();

      const cancelled = await cancel();
      expect(cancelled.body.launch).toMatchObject({
        state: 'cancelling',
        progress: null,
      });
      socket.progress(ask.requestId, 'steps', 5, 9);
      await socket.roundTrip();
      expect(await progress()).toBeNull();

      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'cancelled',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'cancelled');
      expect(await progress()).toBeNull();
    });

    it('shows null after run.finished', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.progress(ask.requestId, 'rendering');
      socket.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'passed',
        runId: null,
      });
      await eventually(async () => (await launchState()) === 'passed');
      expect(await progress()).toBeNull();
      // A late frame after the end changes nothing.
      socket.progress(ask.requestId, 'steps', 1, 2);
      await socket.roundTrip();
      expect(online()).toBe(true);
      expect(await progress()).toBeNull();
    });

    it("ignores an unknown launch id and another machine's frame, and keeps both sockets", async () => {
      const other = await pair(http, alice, 'Desktop');
      const intruder = await daemon(other);
      const socket = await daemon();
      const { ask } = await running(socket);

      socket.progress(randomUUID(), 'app');
      intruder.progress(ask.requestId, 'steps', 1, 3);
      await socket.roundTrip();
      await intruder.roundTrip();
      expect(online()).toBe(true);
      expect(t.app.get(RunnerConnections).isOnline(other.runnerId)).toBe(true);
      expect(await progress()).toBeNull();
    });

    it('does not reset the 20-minute run timeout', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      for (let second = 1; second < RUN_TIMEOUT_MS / 1000; second += 1) {
        t.clock.advance(1000);
        socket.progress(ask.requestId, 'steps', 1, 2);
        // Well inside the idle timeout the real-time heartbeat checks.
        if (second % 30 === 0) {
          await socket.roundTrip();
        }
        service().tick();
      }
      await socket.roundTrip();
      expect(await launchState()).toBe('running');
      sweep(1000);
      expect(await launchState()).toBe('lost');
    });

    it('keeps the last progress of a detached launch, and a frame after the re-sync replaces it', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.progress(ask.requestId, 'steps', 2, 6);
      await socket.roundTrip();
      await drop(socket);
      expect(await progress()).toEqual({ phase: 'steps', step: 2, steps: 6 });

      const later = await daemon();
      later.sync([ask.requestId]);
      await later.roundTrip();
      expect(await progress()).toEqual({ phase: 'steps', step: 2, steps: 6 });
      later.progress(ask.requestId, 'steps', 5, 6);
      await later.roundTrip();
      expect(await progress()).toEqual({ phase: 'steps', step: 5, steps: 6 });
    });
  });

  describe('stray answers', () => {
    it('drops answers with an unknown requestId, and keeps the socket', async () => {
      const socket = await daemon();
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      for (const message of [
        {
          type: 'scenarios.listed',
          requestId: randomUUID(),
          scenarios: [],
          truncated: false,
          skipped: 0,
        },
        { type: 'run.started', requestId: randomUUID(), scenarioName: 'x' },
        { type: 'run.error', requestId: randomUUID(), code: 'io' },
        {
          type: 'run.finished',
          requestId: randomUUID(),
          outcome: 'passed',
          runId: null,
        },
      ]) {
        socket.send(message);
      }
      await socket.roundTrip();
      expect(online()).toBe(true);

      socket.send({
        type: 'scenarios.error',
        requestId: ask.requestId,
        code: 'io',
      });
      expect((await pending).status).toBe(502);
    });

    it("ignores another machine's answers", async () => {
      const other = await pair(http, alice, 'Desktop');
      const intruder = await daemon(other);
      const socket = await daemon();

      const listing = list();
      const listAsk = await socket.nextLaunch('scenarios.list');
      intruder.send({
        type: 'scenarios.error',
        requestId: listAsk.requestId,
        code: 'io',
      });
      await intruder.roundTrip();
      socket.send({
        type: 'scenarios.listed',
        requestId: listAsk.requestId,
        scenarios: [],
        truncated: false,
        skipped: 0,
      });
      expect((await listing).status).toBe(200);

      const starting = start();
      const startAsk = await socket.nextLaunch('run.start');
      intruder.send({
        type: 'run.error',
        requestId: startAsk.requestId,
        code: 'io',
      });
      await intruder.roundTrip();
      socket.send({
        type: 'run.started',
        requestId: startAsk.requestId,
        scenarioName: 'Checkout',
      });
      expect((await starting).status).toBe(202);

      intruder.send({
        type: 'run.finished',
        requestId: startAsk.requestId,
        outcome: 'failed',
        runId: null,
      });
      await intruder.roundTrip();
      expect(await launchState()).toBe('running');
    });

    it('drops a frame that fails validation, keeps the socket, and the request times out', async () => {
      const socket = await daemon();
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      socket.send({
        type: 'scenarios.listed',
        requestId: ask.requestId,
        scenarios: [{ id: '../etc/passwd', name: 'x' }],
        truncated: false,
        skipped: 0,
      });
      await socket.roundTrip();
      expect(online()).toBe(true);
      sweep(LIST_TIMEOUT_MS);
      expect((await pending).status).toBe(504);
    });
  });

  describe('output formats (spec #325)', () => {
    const FORMATS = ['gif', 'mp4-vertical'];

    /** A daemon whose sync carried `runOptions` (none when undefined), once the server has it. */
    async function announcing(runOptions: unknown) {
      const socket = await daemon();
      socket.sync([], runOptions);
      await socket.roundTrip();
      return socket;
    }

    async function listed(socket: TestSocket): Promise<Response> {
      const pending = list();
      const ask = await socket.nextLaunch('scenarios.list');
      socket.send({
        type: 'scenarios.listed',
        requestId: ask.requestId,
        scenarios: [],
        truncated: false,
        skipped: 0,
      });
      return pending;
    }

    it('sends run.start without an options key when no formats were chosen', async () => {
      const socket = await announcing(['formats']);
      const pending = start();
      const ask = await socket.nextLaunch('run.start');
      expect(Object.keys(ask).sort()).toEqual([
        'requestId',
        'rootPath',
        'scenarioId',
        'type',
      ]);
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      expect((await pending).body.launch.formats).toBeNull();
    });

    it('sends the chosen formats in their order and shows them on the launch', async () => {
      const socket = await announcing(['formats']);
      const pending = start({ scenarioId: SCENARIO, formats: FORMATS });
      const ask = await socket.nextLaunch('run.start');
      expect(ask).toEqual({
        type: 'run.start',
        requestId: expect.stringMatching(UUID_V4),
        rootPath: ROOT,
        scenarioId: SCENARIO,
        options: { formats: FORMATS },
      });
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });

      const res = await pending;
      expect(res.status).toBe(202);
      expect(res.body.launch.formats).toEqual(FORMATS);
      expect((await latest()).body.launch.formats).toEqual(FORMATS);
    });

    it('keeps the formats on a launch reattached by launches.sync', async () => {
      const socket = await announcing(['formats']);
      const pending = start({ scenarioId: SCENARIO, formats: FORMATS });
      const ask = await socket.nextLaunch('run.start');
      socket.send({
        type: 'run.started',
        requestId: ask.requestId,
        scenarioName: 'Checkout',
      });
      expect((await pending).status).toBe(202);
      await drop(socket);
      const later = await daemon();
      later.sync([ask.requestId], ['formats']);
      await later.roundTrip();
      expect((await latest()).body.launch).toMatchObject({
        state: 'running',
        formats: FORMATS,
      });
    });

    it.each([
      ['an empty list', []],
      ['an unknown format', ['mov']],
      ['a repeated format', ['mp4', 'mp4']],
      [
        'ten entries',
        [
          'mp4',
          'gif',
          'webm',
          'mp4-vertical',
          'gif-vertical',
          'webm-vertical',
          'mp4-square',
          'gif-square',
          'webm-square',
          'mp4',
        ],
      ],
      ['a string', 'mp4'],
      ['null', null],
    ])('400s formats as %s and sends nothing', async (_label, formats) => {
      const socket = await announcing(['formats']);
      const res = await start({ scenarioId: SCENARIO, formats });
      expect(res.status).toBe(400);
      await expectNothingSent(socket);
    });

    it('400s another run option and sends nothing', async () => {
      const socket = await announcing(['formats']);
      const res = await start({ scenarioId: SCENARIO, headed: true });
      expect(res.status).toBe(400);
      await expectNothingSent(socket);
    });

    it('accepts all nine formats', async () => {
      const socket = await announcing(['formats']);
      const all = [
        'webm-square',
        'mp4',
        'gif',
        'webm',
        'mp4-vertical',
        'gif-vertical',
        'webm-vertical',
        'mp4-square',
        'gif-square',
      ];
      const pending = start({ scenarioId: SCENARIO, formats: all });
      const ask = await socket.nextLaunch('run.start');
      expect(ask.options).toEqual({ formats: all });
      socket.send({ type: 'run.error', requestId: ask.requestId, code: 'io' });
      expect((await pending).status).toBe(502);
    });

    it.each([
      ['a sync without runOptions', undefined],
      ['a sync with only unknown options', ['later']],
      ['a sync with no options', []],
    ])('409s runner-outdated after %s, sends nothing, and starts without formats', async (_label, runOptions) => {
      const socket = await announcing(runOptions);
      const res = await start({ scenarioId: SCENARIO, formats: FORMATS });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-outdated' });
      await expectNothingSent(socket);
      expect((await latest()).body).toEqual({ launch: null });
      await running(socket);
    });

    it('409s runner-outdated to a daemon that sent no sync at all', async () => {
      const socket = await daemon();
      const res = await start({ scenarioId: SCENARIO, formats: FORMATS });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-outdated' });
      await expectNothingSent(socket);
      await running(socket);
    });

    it('forgets the options of a replaced socket', async () => {
      await announcing(['formats']);
      // No sync on the new socket: only the connection could have kept them.
      const later = await daemon();
      const res = await start({ scenarioId: SCENARIO, formats: FORMATS });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-outdated' });
      await expectNothingSent(later);
    });

    it('answers runner-offline before runner-outdated', async () => {
      const res = await start({ scenarioId: SCENARIO, formats: FORMATS });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-offline' });
    });

    it('answers runner-outdated before runner-busy', async () => {
      const socket = await announcing(undefined);
      await running(socket);
      const res = await start({ scenarioId: SCENARIO, formats: FORMATS });
      expect(res.body).toEqual({ error: 'runner-outdated' });
    });

    it('answers run.error options-invalid with 422 and leaves no launch', async () => {
      const socket = await announcing(['formats']);
      const pending = start({ scenarioId: SCENARIO, formats: FORMATS });
      const ask = await socket.nextLaunch('run.start');
      socket.send({
        type: 'run.error',
        requestId: ask.requestId,
        code: 'options-invalid',
      });

      const res = await pending;
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: 'options-invalid' });
      expect((await latest()).body).toEqual({ launch: null });
    });

    it('lists the options the machine accepts, without the ones the API does not know', async () => {
      const socket = await announcing(['later', 'formats']);
      const res = await listed(socket);
      expect(res.status).toBe(200);
      expect(res.body.runOptions).toEqual(['formats']);
    });

    it.each([
      ['nine', Array.from({ length: 9 }, () => 'formats')],
      ['a 33-character one', ['formats', 'x'.repeat(33)]],
    ])('drops a sync with %s options as invalid', async (_label, runOptions) => {
      const socket = await announcing(runOptions);
      expect((await listed(socket)).body.runOptions).toEqual([]);
    });
  });
});
