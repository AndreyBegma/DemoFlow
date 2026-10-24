import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { TestSocket } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { DELETE_RUNS_MAX } from './projects.dto';

describe('deleting several runs at once (integration, spec #286)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let laptop: Paired;
  let projectId: string;
  let runIds: string[];
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    laptop = await pair(http, alice, 'Laptop');
    const first = await report(laptop, '/home/alice/shop', 'one');
    projectId = first.projectId;
    runIds = [first.runId];
    for (const name of ['two', 'three', 'four']) {
      runIds.push((await report(laptop, '/home/alice/shop', name)).runId);
    }
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(
    on: Paired,
    rootPath: string,
    scenarioName: string,
  ): Promise<{ projectId: string; runId: string }> {
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${on.token}`)
      .send({
        rootPath,
        projectName: 'shop',
        scenarioName,
        scenarioPath: `demoflow/${scenarioName}.demo.json`,
        status: 'passed',
        startedAt: t.clock.now().toISOString(),
        durationMs: 1000,
        formats: ['mp4'],
        cliVersion: '0.4.0',
      })
      .expect(201);
    return res.body;
  }

  function remove(body: unknown, cookie = alice.cookie, id = projectId) {
    return request(http)
      .post(`/projects/${id}/runs/delete`)
      .set('Cookie', cookie)
      .send(body as object);
  }

  async function listed(id = projectId, cookie = alice.cookie) {
    const res = await request(http)
      .get(`/projects/${id}/runs`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body.runs.map((run: { id: string }) => run.id);
  }

  it('deletes the listed runs and keeps the others', async () => {
    const res = await remove({ runIds: runIds.slice(0, 3) }).expect(200);

    expect(res.body).toEqual({ deleted: 3 });
    expect(await listed()).toEqual([runIds[3]]);
  });

  it('skips ids that are not runs of this project, and deletes the rest', async () => {
    const other = await report(laptop, '/home/alice/blog', 'post');
    const desk = await pair(http, bob, 'Desk');
    const foreign = await report(desk, '/home/bob/shop', 'bobs');

    const res = await remove({
      runIds: [runIds[0], runIds[1], 'no-such-run', other.runId, foreign.runId],
    }).expect(200);

    expect(res.body).toEqual({ deleted: 2 });
    expect((await listed()).sort()).toEqual([runIds[2], runIds[3]].sort());
    expect(await listed(other.projectId)).toEqual([other.runId]);
    expect(await listed(foreign.projectId, bob.cookie)).toEqual([
      foreign.runId,
    ]);
  });

  it('answers 0 when the same request is sent twice', async () => {
    await remove({ runIds: [runIds[0]] }).expect(200);

    const again = await remove({ runIds: [runIds[0]] }).expect(200);

    expect(again.body).toEqual({ deleted: 0 });
  });

  it("answers 404 and deletes nothing for another user's or an unknown project", async () => {
    await remove({ runIds }, bob.cookie).expect(404);
    await remove({ runIds }, alice.cookie, 'nope').expect(404);

    expect(await listed()).toHaveLength(4);
  });

  it.each([
    ['an empty list', { runIds: [] }],
    [
      `${DELETE_RUNS_MAX + 1} ids`,
      {
        runIds: Array.from({ length: DELETE_RUNS_MAX + 1 }, (_, i) => `r${i}`),
      },
    ],
    ['a duplicate id', () => ({ runIds: [runIds[0], runIds[0]] })],
    ['a 65-character id', { runIds: ['x'.repeat(65)] }],
    ['an empty id', { runIds: [''] }],
    ['a non-string id', { runIds: [1] }],
    ['a missing runIds', {}],
  ])('answers 400 and deletes nothing for %s', async (_name, body) => {
    await remove(typeof body === 'function' ? body() : body).expect(400);

    expect(await listed()).toHaveLength(4);
  });

  it('accepts exactly the maximum', async () => {
    const ids = Array.from({ length: DELETE_RUNS_MAX }, (_, i) => `r${i}`);

    const res = await remove({ runIds: ids }).expect(200);

    expect(res.body).toEqual({ deleted: 0 });
  });

  it('answers 401 without a session', async () => {
    await request(http)
      .post(`/projects/${projectId}/runs/delete`)
      .send({ runIds })
      .expect(401);

    expect(await listed()).toHaveLength(4);
  });

  it('sends nothing to a connected Runner', async () => {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      laptop.token,
    );
    sockets.push(socket);

    await remove({ runIds }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(socket.received).toEqual([]);
  });
});
