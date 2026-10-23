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
  RUN_TIMEOUT_MS,
  START_TIMEOUT_MS,
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
      expect(res.body).toEqual({ scenarios, truncated: true, skipped: 2 });
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

    it('marks a running launch lost, and drops its run.finished on a later socket', async () => {
      const socket = await daemon();
      const { ask } = await running(socket);
      socket.ws.terminate();
      await eventually(async () => (await launchState()) === 'lost');

      const later = await daemon();
      later.send({
        type: 'run.finished',
        requestId: ask.requestId,
        outcome: 'passed',
        runId,
      });
      await later.roundTrip();
      expect(await launchState()).toBe('lost');
    });

    it('marks a cancelling launch lost when another socket replaces it', async () => {
      const socket = await daemon();
      await running(socket);
      await cancel();
      await daemon();
      expect(await launchState()).toBe('lost');
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
});
