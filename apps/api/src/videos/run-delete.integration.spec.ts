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

const WEB_ORIGIN = 'http://localhost:3670';

describe("deleting a run's metadata (integration)", () => {
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
    ({ projectId, runId } = await report());
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(): Promise<{ projectId: string; runId: string }> {
    const res = await request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${machine.token}`)
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
    return res.body;
  }

  function remove(cookie = alice.cookie, id = runId) {
    return request(http).delete(`/runs/${id}`).set('Cookie', cookie);
  }

  async function exists(id = runId): Promise<boolean> {
    return (await t.prisma.run.count({ where: { id } })) === 1;
  }

  async function lastRunId(): Promise<string | null> {
    const res = await request(http)
      .get('/projects')
      .set('Cookie', alice.cookie)
      .expect(200);
    const project = res.body.projects.find(
      (p: { id: string }) => p.id === projectId,
    );
    return project.lastRun?.id ?? null;
  }

  describe('the owner', () => {
    it('answers 204 and the run is gone from the run page and the library', async () => {
      const res = await remove();
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      await request(http)
        .get(`/runs/${runId}`)
        .set('Cookie', alice.cookie)
        .expect(404, { error: 'not-found' });
      const library = await request(http)
        .get(`/projects/${projectId}/runs`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(library.body.runs).toEqual([]);
      expect(await exists()).toBe(false);
    });

    it('moves lastRun to the next newest run, then to null; the project stays', async () => {
      const older = runId;
      t.clock.advance(60_000);
      const { runId: newer } = await report();
      expect(await lastRunId()).toBe(newer);

      await remove(alice.cookie, newer).expect(204);
      expect(await lastRunId()).toBe(older);

      await remove(alice.cookie, older).expect(204);
      expect(await lastRunId()).toBeNull();
    });

    it('answers a second DELETE with 404', async () => {
      await remove().expect(204);
      await remove().expect(404, { error: 'not-found' });
    });

    it('deletes a run whose artifacts were deleted the same way', async () => {
      t.clock.advance(60_000);
      const { runId: cleaned } = await report();
      await t.prisma.run.update({
        where: { id: cleaned },
        data: { artifactsDeletedAt: t.clock.now() },
      });

      await remove(alice.cookie, cleaned).expect(204);
      await remove().expect(204);
      expect(await exists(cleaned)).toBe(false);
      expect(await exists()).toBe(false);
    });

    it('sends nothing to the machine that recorded the run', async () => {
      const socket = await TestSocket.connect(
        `ws://127.0.0.1:${port}/runner`,
        machine.token,
      );
      sockets.push(socket);
      const before = socket.received.length;

      await remove().expect(204);
      await socket.roundTrip();
      expect(socket.received.slice(before)).toEqual([]);
    });
  });

  describe('not the owner', () => {
    it("answers 404 for another user's run and keeps the row", async () => {
      await remove(bob.cookie).expect(404, { error: 'not-found' });
      expect(await exists()).toBe(true);
    });

    it('answers 404 for an unknown id', async () => {
      await remove(alice.cookie, 'no-such-run').expect(404, {
        error: 'not-found',
      });
    });
  });

  describe('the request', () => {
    it('answers 400 for an id longer than 64 characters', async () => {
      await remove(alice.cookie, 'a'.repeat(65)).expect(400);
    });

    it('requires a session', async () => {
      await request(http).delete(`/runs/${runId}`).expect(401);
      expect(await exists()).toBe(true);
    });

    it('refuses another origin and keeps the row', async () => {
      await remove().set('Origin', 'https://evil.example').expect(403);
      expect(await exists()).toBe(true);
      await remove().set('Origin', WEB_ORIGIN).expect(204);
    });
  });
});
