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
import { TestSocket } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import { ArtifactsService, DELETE_TIMEOUT_MS } from './artifacts.service';

describe("deleting a run's artifacts through the runner socket (integration)", () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
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
    runId = await report(machine);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(on: Paired): Promise<string> {
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${on.token}`)
      .send({
        rootPath: '/home/alice/shop',
        projectName: 'shop',
        scenarioName: 'checkout',
        scenarioPath: 'demos/checkout.yaml',
        status: 'passed',
        startedAt: t.clock.now().toISOString(),
        durationMs: 12_345,
        formats: ['mp4'],
        cliVersion: '0.4.0',
      })
      .expect(201);
    return res.body.runId;
  }

  async function daemon(on = machine): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      on.token,
    );
    sockets.push(socket);
    return socket;
  }

  /** Starts the `DELETE`, so a test can answer as the daemon meanwhile. */
  function remove(cookie = alice.cookie, id = runId): Promise<Response> {
    return request(http)
      .delete(`/runs/${id}/artifacts`)
      .set('Cookie', cookie)
      .then((res) => res);
  }

  async function deletedAt(): Promise<Date | null> {
    const run = await t.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    return run.artifactsDeletedAt;
  }

  /** Nothing reached the daemon: every frame before the round trip is in. */
  async function expectNothingSent(socket: TestSocket): Promise<void> {
    await socket.roundTrip();
    expect(
      socket.received.filter((m) => m.type === 'artifacts.delete'),
    ).toEqual([]);
  }

  function online(): boolean {
    return t.app.get(RunnerConnections).isOnline(machine.runnerId);
  }

  describe('success', () => {
    it('sends artifacts.delete, answers 204 and records the time', async () => {
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      expect(ask).toEqual({
        type: 'artifacts.delete',
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        runId,
      });
      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });

      const res = await pending;
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await deletedAt()).toEqual(t.clock.now());
    });

    it('answers a second DELETE with 204 and sends nothing', async () => {
      const socket = await daemon();
      const first = remove();
      const ask = await socket.nextDelete();
      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      expect((await first).status).toBe(204);
      const recorded = await deletedAt();

      t.clock.advance(60_000);
      expect((await remove()).status).toBe(204);
      await expectNothingSent(socket);
      expect(await deletedAt()).toEqual(recorded);
    });

    it('keeps the run in the library', async () => {
      await t.prisma.run.update({
        where: { id: runId },
        data: { artifactsDeletedAt: t.clock.now() },
      });
      await request(http)
        .get(`/runs/${runId}`)
        .set('Cookie', alice.cookie)
        .expect(200);
    });
  });

  describe('who may delete', () => {
    it("404s another account's run and an unknown run, and sends nothing", async () => {
      const socket = await daemon();
      for (const res of [
        await remove(bob.cookie),
        await remove(alice.cookie, randomUUID()),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'not-found' });
      }
      await expectNothingSent(socket);
    });

    it('401s without a session', async () => {
      await request(http).delete(`/runs/${runId}/artifacts`).expect(401);
    });

    it('403s a foreign origin', async () => {
      await request(http)
        .delete(`/runs/${runId}/artifacts`)
        .set('Cookie', alice.cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });
  });

  describe('machine state', () => {
    it('answers 503 runner-offline when the machine has no socket', async () => {
      const res = await remove();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-offline' });
    });

    it('answers 503 runner-removed when the machine was revoked', async () => {
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      const res = await remove();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-removed' });
    });

    it('answers 503 runner-removed when the run has no machine', async () => {
      const socket = await daemon();
      await t.prisma.run.update({
        where: { id: runId },
        data: { runnerId: null },
      });
      const res = await remove();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-removed' });
      await expectNothingSent(socket);
    });
  });

  describe('runner answers', () => {
    it.each([
      ['not-found', 404, 'artifacts-missing'],
      ['io', 502, 'runner-error'],
    ])('answers %s with %i %s and records nothing', async (code, status, error) => {
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      socket.send({ type: 'artifacts.error', requestId: ask.requestId, code });

      const res = await pending;
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
      expect(await deletedAt()).toBeNull();
    });

    it('ignores an error code it does not know, and keeps the socket', async () => {
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      socket.send({
        type: 'artifacts.error',
        requestId: ask.requestId,
        code: 'weird',
      });
      await socket.roundTrip();
      expect(online()).toBe(true);
      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      expect((await pending).status).toBe(204);
    });

    it('drops an answer with an unknown requestId, and keeps the socket', async () => {
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      socket.send({ type: 'artifacts.deleted', requestId: randomUUID() });
      socket.send({
        type: 'artifacts.error',
        requestId: randomUUID(),
        code: 'io',
      });
      await socket.roundTrip();
      expect(online()).toBe(true);
      expect(await deletedAt()).toBeNull();

      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      expect((await pending).status).toBe(204);
    });

    it("ignores another machine's answer for a request", async () => {
      const other = await pair(http, alice, 'Desktop');
      const intruder = await daemon(other);
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      intruder.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      await intruder.roundTrip();
      expect(await deletedAt()).toBeNull();

      socket.send({
        type: 'artifacts.error',
        requestId: ask.requestId,
        code: 'io',
      });
      expect((await pending).status).toBe(502);
    });
  });

  describe('timeout and close', () => {
    it('answers 504 runner-timeout after 15 s and drops a late answer', async () => {
      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      const service = t.app.get(ArtifactsService);
      t.clock.advance(DELETE_TIMEOUT_MS - 1);
      service.tick();
      t.clock.advance(1);
      service.tick();

      const res = await pending;
      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'runner-timeout' });

      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      await socket.roundTrip();
      expect(online()).toBe(true);
      expect(await deletedAt()).toBeNull();
    });

    it('answers 503 runner-offline when the socket closes before the answer', async () => {
      const socket = await daemon();
      const pending = remove();
      await socket.nextDelete();
      socket.ws.terminate();

      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-offline' });
      expect(await deletedAt()).toBeNull();
    });

    it('answers 503 runner-offline when another socket replaces it', async () => {
      const socket = await daemon();
      const pending = remove();
      await socket.nextDelete();
      await daemon();

      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'runner-offline' });
    });
  });

  describe('after deletion', () => {
    beforeEach(async () => {
      await t.prisma.run.update({
        where: { id: runId },
        data: { artifactsDeletedAt: t.clock.now() },
      });
    });

    it('answers playback with 410 artifacts-deleted and sends nothing', async () => {
      const socket = await daemon();
      const res = await request(http)
        .get(`/runs/${runId}/video/mp4`)
        .set('Cookie', alice.cookie);
      expect(res.status).toBe(410);
      expect(res.body).toEqual({ error: 'artifacts-deleted' });
      await socket.roundTrip();
      expect(socket.received.filter((m) => m.type === 'video.open')).toEqual(
        [],
      );
    });

    it('still 404s a format that was never rendered', async () => {
      await request(http)
        .get(`/runs/${runId}/video/webm`)
        .set('Cookie', alice.cookie)
        .expect(404);
    });
  });

  describe('views carry artifactsDeletedAt', () => {
    async function views(): Promise<unknown[]> {
      const page = await request(http)
        .get(`/runs/${runId}`)
        .set('Cookie', alice.cookie)
        .expect(200);
      const projectId: string = page.body.project.id;
      const runs = await request(http)
        .get(`/projects/${projectId}/runs`)
        .set('Cookie', alice.cookie)
        .expect(200);
      const projects = await request(http)
        .get('/projects')
        .set('Cookie', alice.cookie)
        .expect(200);
      const project = (
        projects.body.projects as Array<{ id: string; lastRun: unknown }>
      ).find((p) => p.id === projectId);
      return [page.body.run, runs.body.runs[0], project?.lastRun];
    }

    it('is null, then the ISO time of the deletion', async () => {
      for (const run of await views()) {
        expect(run).toMatchObject({ id: runId, artifactsDeletedAt: null });
      }

      const socket = await daemon();
      const pending = remove();
      const ask = await socket.nextDelete();
      socket.send({ type: 'artifacts.deleted', requestId: ask.requestId });
      expect((await pending).status).toBe(204);

      for (const run of await views()) {
        expect(run).toMatchObject({
          id: runId,
          artifactsDeletedAt: t.clock.now().toISOString(),
        });
      }
    });
  });
});
