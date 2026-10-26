import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ClientRequest,
  get as httpGet,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { RunnerConnections } from '../runner/runner-connections.service';
import { encodeVideoChunk } from '../runner/runner-socket';
import { eventually, TestSocket } from '../runner/runner-socket.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';
import {
  CHUNK_TIMEOUT_MS,
  HEAD_TIMEOUT_MS,
  VideoRelay,
} from './video-relay.service';

const FILE = randomBytes(2500);

interface Played {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The whole message arrived; false when the server destroyed it. */
  complete: boolean;
}

interface Pending {
  req: ClientRequest;
  response: Promise<IncomingMessage>;
  done: Promise<Played>;
}

describe('run video through the runner relay (integration)', () => {
  let t: TestApp;
  let http: App;
  let port: number;
  let alice: SignedIn;
  let bob: SignedIn;
  let machine: Paired;
  let runId: string;
  const sockets: TestSocket[] = [];
  const requests: ClientRequest[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer();
    port = (http.address() as AddressInfo).port;
    alice = await signedInUser(t, 'alice');
    bob = await signedInUser(t, 'bob');
    machine = await pair(http, alice, 'Laptop');
    runId = await report([
      'mp4',
      'webm',
      'mp4-vertical',
      'webm-vertical',
      'gif-vertical',
      'mp4-square',
      'webm-square',
      'gif-square',
    ]);
  });

  afterEach(async () => {
    for (const req of requests.splice(0)) {
      req.destroy();
    }
    for (const socket of sockets.splice(0)) {
      socket.ws.terminate();
    }
    await t.app.close();
  });

  async function report(formats: string[]): Promise<string> {
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
        formats,
        cliVersion: '0.4.0',
      })
      .expect(201);
    return res.body.runId;
  }

  async function daemon(): Promise<TestSocket> {
    const socket = await TestSocket.connect(
      `ws://127.0.0.1:${port}/runner`,
      machine.token,
    );
    sockets.push(socket);
    return socket;
  }

  /** A raw GET, so a test can watch, pause or abort the response. */
  function play(
    format = 'mp4',
    headers: Record<string, string> = {},
    cookie = alice.cookie,
    id = runId,
  ): Pending {
    const req = httpGet({
      host: '127.0.0.1',
      port,
      path: `/runs/${id}/video/${format}`,
      headers: { Cookie: cookie, ...headers },
    });
    requests.push(req);
    let answered = false;
    const response = new Promise<IncomingMessage>((resolve) =>
      req.once('response', (res: IncomingMessage) => {
        answered = true;
        resolve(res);
      }),
    );
    // Destroyed before the headers left: no response at all, never complete.
    const hungUp = new Promise<Played>((resolve) =>
      req.on('error', () => {
        if (!answered) {
          resolve({
            status: 0,
            headers: {},
            body: Buffer.alloc(0),
            complete: false,
          });
        }
      }),
    );
    const read = response.then(
      (res) =>
        new Promise<Played>((resolve) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', () => {});
          res.on('close', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
              complete: res.complete,
            }),
          );
        }),
    );
    const done = Promise.race([hungUp, read]);
    return { req, response, done };
  }

  function errorOf(played: Played): unknown {
    return JSON.parse(played.body.toString()).error;
  }

  describe('the whole file and ranges', () => {
    it('answers 200 with the whole file, byte for byte', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      expect(open).toEqual({
        type: 'video.open',
        streamId: expect.any(String),
        runId,
        format: 'mp4',
        range: null,
      });
      socket.serve(open.streamId, FILE);

      const played = await pending.done;
      expect(played.status).toBe(200);
      expect(played.complete).toBe(true);
      expect(played.body.equals(FILE)).toBe(true);
      expect(played.headers).toMatchObject({
        'content-type': 'video/mp4',
        'content-length': String(FILE.length),
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'content-disposition': 'inline',
      });
      expect(played.headers['content-range']).toBeUndefined();
    });

    it.each([
      ['webm', 'video/webm'],
      ['mp4-vertical', 'video/mp4'],
      ['webm-vertical', 'video/webm'],
      ['gif-vertical', 'image/gif'],
      ['mp4-square', 'video/mp4'],
      ['webm-square', 'video/webm'],
      ['gif-square', 'image/gif'],
    ])('serves %s as %s', async (format, type) => {
      const socket = await daemon();
      const pending = play(format);
      const open = await socket.nextOpen();
      expect(open.format).toBe(format);
      socket.serve(open.streamId, FILE);
      expect((await pending.done).headers['content-type']).toBe(type);
    });

    it.each([
      ['bytes=100-1099', { start: 100, end: 1099 }, 100, 1099],
      ['bytes=2000-', { start: 2000 }, 2000, 2499],
      ['bytes=-300', { suffix: 300 }, 2200, 2499],
    ])('answers %s with 206', async (header, range, start, end) => {
      const socket = await daemon();
      const pending = play('mp4', { Range: header });
      const open = await socket.nextOpen();
      expect(open.range).toEqual(range);
      socket.serve(open.streamId, FILE, { start, end });

      const played = await pending.done;
      expect(played.status).toBe(206);
      expect(played.complete).toBe(true);
      expect(played.headers['content-range']).toBe(
        `bytes ${start}-${end}/${FILE.length}`,
      );
      expect(played.headers['content-length']).toBe(String(end - start + 1));
      expect(played.headers['accept-ranges']).toBe('bytes');
      expect(played.body.equals(FILE.subarray(start, end + 1))).toBe(true);
    });

    it('sends a multi-range header as the whole file', async () => {
      const socket = await daemon();
      const pending = play('mp4', { Range: 'bytes=0-1,5-6' });
      const open = await socket.nextOpen();
      expect(open.range).toBeNull();
      socket.serve(open.streamId, FILE);
      expect((await pending.done).status).toBe(200);
    });

    it('answers bad-range with 416 and the size', async () => {
      const socket = await daemon();
      const pending = play('mp4', { Range: 'bytes=9000-' });
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.error',
        streamId: open.streamId,
        code: 'bad-range',
        size: FILE.length,
      });

      const played = await pending.done;
      expect(played.status).toBe(416);
      expect(played.headers['content-range']).toBe(`bytes */${FILE.length}`);
      expect(errorOf(played)).toBe('bad-range');
    });

    it('answers a head that is not the span asked for with 502, and cancels', async () => {
      const socket = await daemon();
      const pending = play('mp4', { Range: 'bytes=0-9' });
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });

      const played = await pending.done;
      expect(played.status).toBe(502);
      expect(errorOf(played)).toBe('runner-error');
      await expect(socket.next('video.cancel')).resolves.toEqual({
        type: 'video.cancel',
        streamId: open.streamId,
      });
    });
  });

  describe('download', () => {
    const attachment = () =>
      `attachment; filename="checkout-${t.clock.now().toISOString().slice(0, 10)}.mp4"`;

    it('answers 200 with an attachment and the whole file', async () => {
      const socket = await daemon();
      const pending = play('mp4?download=1');
      const open = await socket.nextOpen();
      expect(open.range).toBeNull();
      socket.serve(open.streamId, FILE);

      const played = await pending.done;
      expect(played.status).toBe(200);
      expect(played.complete).toBe(true);
      expect(played.body.equals(FILE)).toBe(true);
      expect(played.headers).toMatchObject({
        'content-type': 'video/mp4',
        'content-length': String(FILE.length),
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'content-disposition': attachment(),
      });
    });

    it('answers a Range with 206 and the same attachment header', async () => {
      const socket = await daemon();
      const pending = play('mp4?download=1', { Range: 'bytes=10-' });
      const open = await socket.nextOpen();
      expect(open.range).toEqual({ start: 10 });
      socket.serve(open.streamId, FILE, { start: 10, end: 2499 });

      const played = await pending.done;
      expect(played.status).toBe(206);
      expect(played.headers['content-disposition']).toBe(attachment());
      expect(played.headers['content-range']).toBe(
        `bytes 10-2499/${FILE.length}`,
      );
      expect(played.body.equals(FILE.subarray(10))).toBe(true);
    });

    it.each([
      'mp4?download=0',
      'mp4?download=true',
      'mp4?download=yes',
      'mp4?foo=1',
    ])('400s %s and sends nothing to the runner', async (path) => {
      const socket = await daemon();
      expect((await play(path).done).status).toBe(400);
      expect(socket.received.filter((m) => m.type === 'video.open')).toEqual(
        [],
      );
    });

    it('answers the same errors as playback', async () => {
      const foreign = await play('mp4?download=1', {}, bob.cookie).done;
      expect(foreign.status).toBe(404);
      const offline = await play('mp4?download=1').done;
      expect(offline.status).toBe(503);
      expect(errorOf(offline)).toBe('runner-offline');

      const socket = await daemon();
      for (let i = 0; i < 4; i += 1) {
        play();
        await socket.nextOpen();
      }
      const busy = await play('mp4?download=1').done;
      expect(busy.status).toBe(503);
      expect(errorOf(busy)).toBe('runner-busy');
    });

    it('answers 410 artifacts-deleted', async () => {
      await daemon();
      await t.prisma.run.update({
        where: { id: runId },
        data: { artifactsDeletedAt: t.clock.now() },
      });
      const played = await play('mp4?download=1').done;
      expect(played.status).toBe(410);
      expect(errorOf(played)).toBe('artifacts-deleted');
    });
  });

  describe('who may play it', () => {
    it("404s another account's run, an unknown run and a format not rendered", async () => {
      await daemon();
      const others = await Promise.all([
        play('mp4', {}, bob.cookie).done,
        play('mp4', {}, alice.cookie, randomUUID()).done,
        play('gif').done,
      ]);
      for (const played of others) {
        expect(played.status).toBe(404);
        expect(errorOf(played)).toBe('not-found');
      }
    });

    it('400s a format that does not exist', async () => {
      expect((await play('avi').done).status).toBe(400);
    });

    it('401s without a session', async () => {
      expect((await play('mp4', {}, '').done).status).toBe(401);
    });
  });

  describe('machine state', () => {
    it('answers 503 runner-offline when the machine has no socket', async () => {
      const played = await play().done;
      expect(played.status).toBe(503);
      expect(errorOf(played)).toBe('runner-offline');
    });

    it('answers 503 runner-removed when the machine was revoked', async () => {
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      const played = await play().done;
      expect(played.status).toBe(503);
      expect(errorOf(played)).toBe('runner-removed');
    });

    it('answers 503 runner-removed when the run has no machine', async () => {
      await daemon();
      await t.prisma.run.update({
        where: { id: runId },
        data: { runnerId: null },
      });
      const played = await play().done;
      expect(errorOf(played)).toBe('runner-removed');
    });

    it('answers a fifth concurrent stream with 503 runner-busy', async () => {
      const socket = await daemon();
      for (let i = 0; i < 4; i += 1) {
        play();
        await socket.nextOpen();
      }
      const played = await play().done;
      expect(played.status).toBe(503);
      expect(errorOf(played)).toBe('runner-busy');
      expect(socket.received.filter((m) => m.type === 'video.open')).toEqual(
        [],
      );
    });
  });

  describe('runner errors before the head', () => {
    it.each([
      ['not-found', 404, 'video-missing'],
      ['busy', 503, 'runner-busy'],
      ['io', 502, 'runner-error'],
      ['something-new', 502, 'runner-error'],
    ])('maps %s to %i %s', async (code, status, error) => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.send({ type: 'video.error', streamId: open.streamId, code });

      const played = await pending.done;
      expect(played.status).toBe(status);
      expect(errorOf(played)).toBe(error);
    });
  });

  describe('timeouts', () => {
    it('answers 504 runner-timeout without a head in 10 s, and cancels', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      const relay = t.app.get(VideoRelay);

      t.clock.advance(HEAD_TIMEOUT_MS - 1);
      relay.tick();
      t.clock.advance(1);
      relay.tick();

      const played = await pending.done;
      expect(played.status).toBe(504);
      expect(errorOf(played)).toBe('runner-timeout');
      await expect(socket.next('video.cancel')).resolves.toEqual({
        type: 'video.cancel',
        streamId: open.streamId,
      });
    });

    it('destroys a stream with no chunk for 30 s, and cancels', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });
      socket.sendChunk(open.streamId, FILE.subarray(0, 100));
      await socket.next('video.ack');
      await pending.response;

      t.clock.advance(CHUNK_TIMEOUT_MS);
      t.app.get(VideoRelay).tick();

      const played = await pending.done;
      expect(played.status).toBe(200);
      expect(played.complete).toBe(false);
      await socket.next('video.cancel');
    });
  });

  describe('ends', () => {
    it('cancels when the browser goes away mid-stream', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });
      socket.sendChunk(open.streamId, FILE.subarray(0, 100));
      await pending.response;
      await socket.next('video.ack');

      pending.req.destroy();

      await expect(socket.next('video.cancel')).resolves.toEqual({
        type: 'video.cancel',
        streamId: open.streamId,
      });
      await eventually(
        () => t.app.get(VideoRelay).openTo(machine.runnerId) === 0,
      );
    });

    it('destroys the response when the runner socket closes mid-stream', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });
      socket.sendChunk(open.streamId, FILE.subarray(0, 100));
      await socket.next('video.ack');
      await pending.response;

      socket.ws.terminate();

      const played = await pending.done;
      expect(played.status).toBe(200);
      expect(played.complete).toBe(false);
    });

    it('answers 503 runner-offline when the socket closes before the head', async () => {
      const socket = await daemon();
      const pending = play();
      await socket.nextOpen();
      socket.ws.terminate();

      const played = await pending.done;
      expect(played.status).toBe(503);
      expect(errorOf(played)).toBe('runner-offline');
    });

    it('ends the streams of a socket another one replaces', async () => {
      const socket = await daemon();
      const pending = play();
      await socket.nextOpen();
      await daemon();

      const played = await pending.done;
      expect(errorOf(played)).toBe('runner-offline');
    });

    it('destroys a short body instead of completing it', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: FILE.length - 1,
      });
      socket.sendChunk(open.streamId, FILE.subarray(0, 100));
      socket.send({ type: 'video.end', streamId: open.streamId });

      const played = await pending.done;
      expect(played.complete).toBe(false);
      expect(played.body.length).toBeLessThan(FILE.length);
    });

    it('destroys a body with bytes beyond the head, and cancels', async () => {
      const socket = await daemon();
      const pending = play('mp4', { Range: 'bytes=0-9' });
      const open = await socket.nextOpen();
      socket.send({
        type: 'video.head',
        streamId: open.streamId,
        size: FILE.length,
        start: 0,
        end: 9,
      });
      socket.sendChunk(open.streamId, FILE.subarray(0, 11));

      const played = await pending.done;
      expect(played.complete).toBe(false);
      await socket.next('video.cancel');
    });
  });

  describe('flow control', () => {
    it('acknowledges every chunk with its own size', async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();
      socket.serve(open.streamId, FILE, { chunkSize: 1000 });
      await pending.done;

      const acks = [
        await socket.next('video.ack'),
        await socket.next('video.ack'),
        await socket.next('video.ack'),
      ];
      expect(acks).toEqual(
        [1000, 1000, 500].map((bytes) => ({
          type: 'video.ack',
          streamId: open.streamId,
          bytes,
        })),
      );
      await socket.roundTrip();
      expect(socket.received.filter((m) => m.type === 'video.ack')).toEqual([]);
    });

    it('drops a chunk for a stream that is not open, and keeps the socket', async () => {
      const socket = await daemon();
      socket.sendRaw(encodeVideoChunk(randomUUID(), Buffer.from('stray')));
      socket.sendRaw(encodeVideoChunk(randomUUID(), Buffer.from('again')));
      await socket.roundTrip();
      expect(t.app.get(RunnerConnections).isOnline(machine.runnerId)).toBe(
        true,
      );
    });

    it("ignores another machine's messages for a stream", async () => {
      const socket = await daemon();
      const pending = play();
      const open = await socket.nextOpen();

      const bobMachine = await pair(http, bob, 'Bob box');
      const intruder = await TestSocket.connect(
        `ws://127.0.0.1:${port}/runner`,
        bobMachine.token,
      );
      sockets.push(intruder);
      intruder.send({
        type: 'video.error',
        streamId: open.streamId,
        code: 'io',
      });
      intruder.sendChunk(open.streamId, Buffer.from('forged'));
      await intruder.roundTrip();

      socket.serve(open.streamId, FILE);
      const played = await pending.done;
      expect(played.status).toBe(200);
      expect(played.body.equals(FILE)).toBe(true);
    });
  });

  describe('GET /runs/:id', () => {
    function page(cookie = alice.cookie, id = runId) {
      return request(http).get(`/runs/${id}`).set('Cookie', cookie);
    }

    it('returns the run, its project and the machine online', async () => {
      await daemon();
      const res = await page().expect(200);
      expect(res.body).toEqual({
        run: {
          id: runId,
          scenarioName: 'checkout',
          scenarioPath: 'demos/checkout.yaml',
          status: 'passed',
          startedAt: t.clock.now().toISOString(),
          durationMs: 12_345,
          formats: [
            'mp4',
            'webm',
            'mp4-vertical',
            'webm-vertical',
            'gif-vertical',
            'mp4-square',
            'webm-square',
            'gif-square',
          ],
          failedStep: null,
          cliVersion: '0.4.0',
          artifactsDeletedAt: null,
          kind: null,
          stages: null,
          renders: null,
          failure: null,
        },
        project: { id: expect.any(String), name: 'shop' },
        machine: {
          id: machine.runnerId,
          name: 'Laptop',
          online: true,
          runOptions: [],
          features: [],
        },
      });
    });

    it('shows the machine offline without a socket', async () => {
      const res = await page().expect(200);
      expect(res.body.machine).toEqual({
        id: machine.runnerId,
        name: 'Laptop',
        online: false,
        runOptions: [],
        features: [],
      });
    });

    it('shows the run options an online machine announced (spec #325)', async () => {
      const socket = await daemon();
      socket.sync([], ['formats', 'later']);
      await socket.roundTrip();
      const res = await page().expect(200);
      expect(res.body.machine).toMatchObject({
        online: true,
        runOptions: ['formats'],
      });
    });

    it('shows the known features an online machine announced (spec #347)', async () => {
      const socket = await daemon();
      socket.sync([], undefined, ['later', 'share']);
      await socket.roundTrip();
      const res = await page().expect(200);
      expect(res.body.machine).toMatchObject({
        online: true,
        features: ['share'],
      });
    });

    it('shows no run options once the announcing machine went offline', async () => {
      const socket = await daemon();
      socket.sync([], ['formats']);
      await socket.roundTrip();
      await socket.close();
      await eventually(
        () => !t.app.get(RunnerConnections).isOnline(machine.runnerId),
      );
      const res = await page().expect(200);
      expect(res.body.machine).toMatchObject({
        online: false,
        runOptions: [],
      });
    });

    it('shows no machine once it was revoked', async () => {
      await request(http)
        .delete(`/runners/${machine.runnerId}`)
        .set('Cookie', alice.cookie)
        .expect(204);
      const res = await page().expect(200);
      expect(res.body.machine).toBeNull();
    });

    it("404s another account's run and an unknown one", async () => {
      await page(bob.cookie).expect(404);
      await page(alice.cookie, randomUUID()).expect(404);
    });
  });
});
