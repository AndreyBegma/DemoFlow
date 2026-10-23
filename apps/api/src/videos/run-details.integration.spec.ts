import request from 'supertest';
import type { App } from 'supertest/types';
import {
  type Paired,
  pair,
  type SignedIn,
  signedInUser,
} from '../runner/runner.fixtures';
import { createTestApp, type TestApp } from '../test/test-app';

const STAGES = {
  readiness: 'passed',
  execution: 'failed',
  verification: 'skipped',
  recording: 'passed',
  rendering: 'pending',
  storage: 'running',
};

const RENDERS = [
  {
    format: 'mp4',
    width: 1280,
    height: 720,
    sizeBytes: 1_234_567,
    durationMs: 12_000,
  },
  {
    format: 'gif-vertical',
    width: 720,
    height: 1280,
    sizeBytes: Number.MAX_SAFE_INTEGER,
    durationMs: 2_147_483_647,
  },
];

const FAILURE = { stage: 'execution', message: 'Locator "#pay" not found' };

/** The stage statuses, renders and failure of a run (spec #263). */
describe('run details (integration)', () => {
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
      rootPath: '/home/alice/shop',
      projectName: 'shop',
      scenarioName: 'checkout',
      scenarioPath: 'demos/checkout.yaml',
      status: 'failed',
      startedAt: t.clock.now().toISOString(),
      durationMs: 12_345,
      formats: ['mp4', 'gif-vertical'],
      failedStep: 2,
      cliVersion: '0.4.0',
      ...overrides,
    };
  }

  function report(body: Record<string, unknown>) {
    return request(http)
      .post('/runner/runs')
      .set('Authorization', `Bearer ${laptop.token}`)
      .send(body);
  }

  /** Reports `body`, then opens the run's page as `cookie`. */
  async function runPage(
    body: Record<string, unknown>,
    cookie = alice.cookie,
    status = 200,
  ) {
    const { runId } = (await report(body).expect(201)).body;
    return request(http)
      .get(`/runs/${runId}`)
      .set('Cookie', cookie)
      .expect(status);
  }

  it('round-trips a full report through the run page', async () => {
    const res = await runPage(
      runReport({ stages: STAGES, renders: RENDERS, failure: FAILURE }),
    );
    expect(res.body.run).toMatchObject({
      status: 'failed',
      failedStep: 2,
      stages: STAGES,
      renders: RENDERS,
      failure: FAILURE,
    });
  });

  it('trims the failure message', async () => {
    const res = await runPage(
      runReport({ failure: { stage: 'rendering', message: '  ffmpeg died ' } }),
    );
    expect(res.body.run.failure).toEqual({
      stage: 'rendering',
      message: 'ffmpeg died',
    });
  });

  it('accepts a report of the old shape and returns three nulls', async () => {
    const res = await runPage(runReport());
    expect(res.body.run).toMatchObject({
      stages: null,
      renders: null,
      failure: null,
    });
  });

  it('accepts no renders as an empty list', async () => {
    const res = await runPage(runReport({ renders: [] }));
    expect(res.body.run.renders).toEqual([]);
  });

  it('returns a stored value of the wrong shape as null', async () => {
    const { runId } = (await report(runReport()).expect(201)).body;
    await t.prisma.run.update({
      where: { id: runId },
      data: {
        stages: { ...STAGES, storage: 'done' },
        renders: [{ ...RENDERS[0], width: '1280' }],
        failureStage: 'upload',
        failureMessage: 'x',
      },
    });
    const res = await request(http)
      .get(`/runs/${runId}`)
      .set('Cookie', alice.cookie)
      .expect(200);
    expect(res.body.run).toMatchObject({
      stages: null,
      renders: null,
      failure: null,
    });
  });

  it('keeps the list endpoints as they were', async () => {
    const { projectId } = (
      await report(
        runReport({ stages: STAGES, renders: RENDERS, failure: FAILURE }),
      ).expect(201)
    ).body;
    const { projects } = (
      await request(http).get('/projects').set('Cookie', alice.cookie)
    ).body;
    const { runs } = (
      await request(http)
        .get(`/projects/${projectId}/runs`)
        .set('Cookie', alice.cookie)
    ).body;
    for (const run of [projects[0].lastRun, runs[0]]) {
      expect(Object.keys(run).sort()).toEqual(
        [
          'id',
          'scenarioName',
          'scenarioPath',
          'status',
          'startedAt',
          'durationMs',
          'formats',
          'failedStep',
          'cliVersion',
          'artifactsDeletedAt',
        ].sort(),
      );
    }
  });

  it("404s another account's run", async () => {
    await runPage(runReport({ stages: STAGES }), bob.cookie, 404);
  });

  describe('rejects a malformed report', () => {
    const { storage: _storage, ...fiveStages } = STAGES;
    const render = RENDERS[0];
    const cases: [string, Record<string, unknown>][] = [
      ['a missing stage', { stages: fiveStages }],
      ['an extra stage', { stages: { ...STAGES, upload: 'passed' } }],
      ['an unknown stage status', { stages: { ...STAGES, storage: 'done' } }],
      ['stages that are not an object', { stages: 'passed' }],
      ['renders that are not a list', { renders: render }],
      ['a duplicate render format', { renders: [render, render] }],
      ['an unknown render format', { renders: [{ ...render, format: 'avi' }] }],
      [
        'seven renders',
        {
          renders: [
            'mp4',
            'gif',
            'webm',
            'mp4-vertical',
            'gif-vertical',
            'webm-vertical',
            'mp4',
          ].map((format) => ({ ...render, format })),
        },
      ],
      ['a non-integer width', { renders: [{ ...render, width: 1280.5 }] }],
      ['a zero height', { renders: [{ ...render, height: 0 }] }],
      ['a width over 16384', { renders: [{ ...render, width: 16_385 }] }],
      ['a negative size', { renders: [{ ...render, sizeBytes: -1 }] }],
      [
        'a size over 2^53 - 1',
        { renders: [{ ...render, sizeBytes: 2 ** 53 }] },
      ],
      [
        'a duration over 2^31 - 1',
        { renders: [{ ...render, durationMs: 2 ** 31 }] },
      ],
      ['a missing render field', { renders: [{ format: 'mp4' }] }],
      ['an extra key in a render', { renders: [{ ...render, path: '/tmp' }] }],
      ['a render that is not an object', { renders: ['mp4'] }],
      [
        'an extra key in the failure',
        { failure: { ...FAILURE, stack: 'at /home/alice' } },
      ],
      [
        'an unknown failure stage',
        { failure: { ...FAILURE, stage: 'upload' } },
      ],
      ['an empty failure message', { failure: { ...FAILURE, message: '  ' } }],
      [
        'a 1001-character failure message',
        { failure: { ...FAILURE, message: 'x'.repeat(1001) } },
      ],
    ];

    it.each(cases)('400s %s', async (_name, fields) => {
      await report(runReport(fields)).expect(400);
    });

    it('accepts a 1000-character failure message', async () => {
      const message = 'x'.repeat(1000);
      const res = await runPage(
        runReport({ failure: { ...FAILURE, message } }),
      );
      expect(res.body.run.failure.message).toBe(message);
    });
  });
});
