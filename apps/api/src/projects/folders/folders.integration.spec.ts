import type { AddressInfo } from 'node:net';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../../runner/runner.fixtures';
import {
  type ProjectRequest,
  TestSocket,
} from '../../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../../test/test-app';
import {
  FOLDER_TIMEOUT_MS,
  FoldersService,
  folderName,
} from './folders.service';

const ROOT = '/home/u/app';
const GITHUB = 'https://github.com/acme/app';
const PROJECT_TYPES = ['project.inspect', 'project.init', 'project.register'];

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    rootPath: ROOT,
    name: 'app',
    hasConfig: true,
    configValid: true,
    scenarios: [{ id: 'demoflow/checkout.demo.json', name: 'Checkout' }],
    githubUrl: GITHUB,
    ...overrides,
  };
}

describe('adding a project from a folder (integration)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice, 'Laptop');
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  /** A connected daemon announcing `features` (`projects` by default). */
  async function daemon(
    features: string[] = ['projects'],
    on = machine,
  ): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      on.token,
    );
    sockets.push(socket);
    socket.sync([], undefined, features);
    await socket.roundTrip();
    return socket;
  }

  /** Starts the request, so a test can answer as the daemon meanwhile. */
  function post(
    action: 'inspect' | 'init' | 'register',
    body: object,
    cookie = alice.cookie,
  ): Promise<Response> {
    return request(http)
      .post(`/projects/folders/${action}`)
      .set('Cookie', cookie)
      .send(body)
      .then((res) => res);
  }

  function projects(cookie = alice.cookie): Promise<Response> {
    return request(http)
      .get('/projects')
      .set('Cookie', cookie)
      .then((res) => res);
  }

  function sentProjectMessages(socket: TestSocket): unknown[] {
    return socket.received.filter((m) => PROJECT_TYPES.includes(m.type));
  }

  /** Plays the daemon through a whole `register` without a `githubUrl`. */
  async function register(
    socket: TestSocket,
    body: object = { runnerId: machine.runnerId, path: '~/app/../app' },
    rootPath = ROOT,
  ): Promise<Response> {
    const pending = post('register', body);
    const inspect = await socket.nextProject('project.inspect');
    socket.send({
      type: 'project.inspected',
      requestId: inspect.requestId,
      inspection: inspection({ rootPath }),
    });
    const ask = await socket.nextProject('project.register');
    socket.send({
      type: 'project.registered',
      requestId: ask.requestId,
      rootPath,
    });
    return pending;
  }

  describe('relaying to the machine', () => {
    it('inspects a folder and answers what the Runner said', async () => {
      const socket = await daemon();
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      const ask = await socket.nextProject('project.inspect');
      expect(ask.path).toBe('~/app');
      socket.send({
        type: 'project.inspected',
        requestId: ask.requestId,
        inspection: inspection(),
      });

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toEqual(inspection());
    });

    it('drops a githubUrl the API would not accept', async () => {
      const socket = await daemon();
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      const ask = await socket.nextProject('project.inspect');
      socket.send({
        type: 'project.inspected',
        requestId: ask.requestId,
        inspection: inspection({ githubUrl: 'https://gitlab.com/acme/app' }),
      });

      expect((await pending).body.githubUrl).toBeNull();
    });

    it('initialises a folder and answers the files and the new inspection', async () => {
      const socket = await daemon();
      const pending = post('init', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      const ask = await socket.nextProject('project.init');
      socket.send({
        type: 'project.initialised',
        requestId: ask.requestId,
        created: ['demoflow.config.json', 'demoflow/hello.demo.json'],
        kept: [],
        inspection: inspection(),
      });

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        created: ['demoflow.config.json', 'demoflow/hello.demo.json'],
        kept: [],
        inspection: inspection(),
      });
    });

    it('registers the canonical rootPath the Runner answered, not the request path', async () => {
      const socket = await daemon();
      const res = await register(socket);

      expect(res.status).toBe(201);
      expect(res.body.project).toEqual(
        expect.objectContaining({
          name: 'app',
          rootPath: ROOT,
          githubUrl: GITHUB,
          source: 'website',
          runner: { id: machine.runnerId, name: 'Laptop' },
          runCount: 0,
          lastRun: null,
        }),
      );
      const row = await t.prisma.project.findUniqueOrThrow({
        where: { id: res.body.project.id },
      });
      expect(row.rootPath).toBe(ROOT);
      expect(row.userId).toBe(alice.user.id);
    });

    it('takes the name and githubUrl of the body without inspecting', async () => {
      const socket = await daemon();
      const pending = post('register', {
        runnerId: machine.runnerId,
        path: '~/app',
        name: '  Shop  ',
        githubUrl: null,
      });
      const ask = await socket.nextProject('project.register');
      socket.send({
        type: 'project.registered',
        requestId: ask.requestId,
        rootPath: ROOT,
      });

      const res = await pending;
      expect(res.status).toBe(201);
      expect(res.body.project).toEqual(
        expect.objectContaining({ name: 'Shop', githubUrl: null }),
      );
      expect(sentProjectMessages(socket)).toEqual([]);
    });

    it('answers 409 project-exists with the first project for the same folder', async () => {
      const socket = await daemon();
      const first = await register(socket);
      const second = await register(socket, {
        runnerId: machine.runnerId,
        path: ROOT,
      });

      expect(second.status).toBe(409);
      expect(second.body).toEqual({
        error: 'project-exists',
        projectId: first.body.project.id,
      });
    });

    it('answers 409 runner-offline and sends nothing without a socket', async () => {
      for (const action of ['inspect', 'init', 'register'] as const) {
        const res = await post(action, {
          runnerId: machine.runnerId,
          path: '~/app',
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'runner-offline' });
      }
    });

    it('answers 409 runner-outdated to a Runner without the projects feature', async () => {
      const socket = await daemon(['share']);
      const res = await post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-outdated' });
      await socket.roundTrip();
      expect(sentProjectMessages(socket)).toEqual([]);
    });

    it('lists the features of an online machine', async () => {
      await daemon();
      const res = await request(http)
        .get('/runners')
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(res.body.runners[0]).toEqual(
        expect.objectContaining({ online: true, features: ['projects'] }),
      );
    });

    it.each([
      ['path-not-allowed', 422, 'path-not-allowed'],
      ['config-missing', 422, 'config-missing'],
      ['config-invalid', 422, 'config-invalid'],
      ['busy', 409, 'runner-busy'],
      ['internal', 502, 'runner-error'],
      ['something-new', 502, 'runner-error'],
    ])('maps project.error %s to %i %s', async (code, status, error) => {
      const socket = await daemon();
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '/etc',
      });
      const ask = await socket.nextProject('project.inspect');
      socket.send({ type: 'project.error', requestId: ask.requestId, code });

      const res = await pending;
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
    });

    it('ends a request with runner-offline when the socket closes', async () => {
      const socket = await daemon();
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      await socket.nextProject('project.inspect');
      await socket.close();

      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'runner-offline' });
    });
  });

  describe('replies', () => {
    it('ignores an unknown requestId, a reply of the wrong kind and another machine', async () => {
      const socket = await daemon();
      const other = await pair(http, alice, 'Desktop');
      const otherSocket = await daemon(['projects'], other);
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      const ask: ProjectRequest = await socket.nextProject('project.inspect');

      socket.send({
        type: 'project.inspected',
        requestId: '6a1f0d4e-2b9c-4c3e-8f7a-1d2e3f4a5b6c',
        inspection: inspection({ name: 'unknown' }),
      });
      socket.send({
        type: 'project.registered',
        requestId: ask.requestId,
        rootPath: '/elsewhere',
      });
      otherSocket.send({
        type: 'project.inspected',
        requestId: ask.requestId,
        inspection: inspection({ name: 'other machine' }),
      });
      await socket.roundTrip();
      await otherSocket.roundTrip();
      socket.send({
        type: 'project.inspected',
        requestId: ask.requestId,
        inspection: inspection(),
      });

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('app');
      // Unanswerable frames never close the socket.
      await socket.roundTrip();
    });

    it('answers 504 runner-timeout when the Runner stays silent for 10 s', async () => {
      const socket = await daemon();
      const pending = post('inspect', {
        runnerId: machine.runnerId,
        path: '~/app',
      });
      const ask = await socket.nextProject('project.inspect');
      const folders = t.app.get(FoldersService);

      t.clock.advance(FOLDER_TIMEOUT_MS - 1);
      folders.tick();
      t.clock.advance(1);
      folders.tick();

      const res = await pending;
      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'runner-timeout' });
      // A late answer finds nothing to settle.
      socket.send({
        type: 'project.inspected',
        requestId: ask.requestId,
        inspection: inspection(),
      });
      await socket.roundTrip();
    });
  });

  describe('authorization', () => {
    it("answers 404 runner-not-found to another account's machine and sends nothing", async () => {
      const socket = await daemon();
      for (const action of ['inspect', 'init', 'register'] as const) {
        const res = await post(
          action,
          { runnerId: machine.runnerId, path: '~/app' },
          bob.cookie,
        );
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'runner-not-found' });
      }
      await socket.roundTrip();
      expect(sentProjectMessages(socket)).toEqual([]);
    });

    it('answers 404 to an unknown machine', async () => {
      const res = await post('inspect', {
        runnerId: 'not-a-machine',
        path: '~/app',
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'runner-not-found' });
    });

    it("keeps a website-added project out of another account's reach", async () => {
      const socket = await daemon();
      const { body } = await register(socket);

      await request(http)
        .patch(`/projects/${body.project.id}`)
        .set('Cookie', bob.cookie)
        .send({ name: 'mine' })
        .expect(404);
      expect((await projects(bob.cookie)).body.projects).toEqual([]);
      expect((await projects()).body.projects).toEqual([
        expect.objectContaining({ id: body.project.id, name: 'app' }),
      ]);
    });

    it('shares 30 requests a minute per user across the three routes', async () => {
      const body = { runnerId: 'not-a-machine', path: '~/app' };
      for (let i = 0; i < 30; i++) {
        const action = (['inspect', 'init', 'register'] as const)[i % 3];
        expect((await post(action, body)).status).toBe(404);
      }
      expect((await post('inspect', body)).status).toBe(429);
      // Per user: another account still has its budget.
      expect((await post('inspect', body, bob.cookie)).status).toBe(404);
    });

    it('needs a session', async () => {
      await request(http)
        .post('/projects/folders/inspect')
        .send({ runnerId: machine.runnerId, path: '~/app' })
        .expect(401);
    });
  });

  describe('githubUrl', () => {
    it.each([
      'https://gitlab.com/acme/app',
      'https://user:secret@github.com/acme/app',
      'http://github.com/acme/app',
      'https://github.com/acme',
      'https://github.com/acme/app/tree/main',
      'https://github.com.evil.example/acme/app',
    ])('rejects %s with 400 and sends nothing', async (githubUrl) => {
      const socket = await daemon();
      const res = await post('register', {
        runnerId: machine.runnerId,
        path: '~/app',
        githubUrl,
      });
      expect(res.status).toBe(400);
      await socket.roundTrip();
      expect(sentProjectMessages(socket)).toEqual([]);
    });

    it('is set, rejected and cleared with PATCH', async () => {
      const created = await request(http)
        .post('/projects')
        .set('Cookie', alice.cookie)
        .send({ name: 'shop' })
        .expect(201);
      const id = created.body.project.id;
      const patch = (body: object) =>
        request(http)
          .patch(`/projects/${id}`)
          .set('Cookie', alice.cookie)
          .send(body);

      expect(created.body.project).toEqual(
        expect.objectContaining({ githubUrl: null, source: 'reported' }),
      );
      expect(
        (await patch({ githubUrl: GITHUB }).expect(200)).body.project,
      ).toEqual(expect.objectContaining({ githubUrl: GITHUB }));
      await patch({ githubUrl: 'https://user:pw@github.com/acme/app' }).expect(
        400,
      );
      expect(
        (await patch({ githubUrl: null }).expect(200)).body.project,
      ).toEqual(expect.objectContaining({ githubUrl: null }));
    });
  });

  describe('input', () => {
    it.each([
      [{ path: '~/app' }],
      [{ runnerId: 'r' }],
      [{ runnerId: 'r', path: '' }],
      [{ runnerId: 'r', path: '~/app', extra: true }],
    ])('rejects %j with 400', async (body) => {
      const res = await post('inspect', body);
      expect(res.status).toBe(400);
    });
  });
});

describe('folderName', () => {
  it.each([
    ['/home/u/app', 'app'],
    ['/home/u/app/', 'app'],
    ['C:\\Users\\u\\shop', 'shop'],
    ['\\\\server\\share\\demo', 'demo'],
    ['/', '/'],
  ])('names %s %s', (rootPath, name) => {
    expect(folderName(rootPath)).toBe(name);
  });
});
