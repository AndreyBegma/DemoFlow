import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredentials } from '../../src/auth/credentials.ts';
import type { HostEnvironment } from '../../src/config/index.ts';
import {
  buildReport,
  isReportOff,
  type ReportDeps,
  reportRun,
} from '../../src/runs-report/report.ts';

const TOKEN = 'dfr_secret-token-value';
const ROOT = path.join(path.sep, 'work', 'shop');

function result(overrides: Partial<RunResult> = {}): RunResult {
  const done = { status: 'passed' } as const;
  return {
    schemaVersion: 1,
    runId: 'run-1',
    scenarioId: 'demoflow/checkout.demo.json',
    scenarioName: 'Checkout',
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:00:12.500Z',
    status: 'completed',
    stages: {
      readiness: done,
      execution: done,
      verification: done,
      recording: done,
      rendering: done,
      storage: { status: 'skipped' },
    },
    renders: [
      {
        renderer: 'ffmpeg',
        format: 'mp4',
        file: 'render/ffmpeg.mp4',
        durationMs: 1,
        sizeBytes: 1,
        width: 1280,
        height: 720,
        fps: 30,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('buildReport', () => {
  it('carries exactly the DTO fields, and no step values', () => {
    const report = buildReport({
      root: ROOT,
      result: result(),
      cliVersion: '1.2.3',
    });
    expect(report).toEqual({
      rootPath: ROOT,
      projectName: 'shop',
      scenarioName: 'Checkout',
      scenarioPath: 'demoflow/checkout.demo.json',
      status: 'passed',
      startedAt: '2026-10-22T10:00:00.000Z',
      durationMs: 12_500,
      formats: ['mp4'],
      cliVersion: '1.2.3',
    });
  });

  it('is failed with the 0-based failed step', () => {
    const failed = result({
      status: 'failed',
      stages: {
        ...result().stages,
        execution: {
          status: 'failed',
          error: { message: 'no such button', stepIndex: 0 },
        },
        verification: { status: 'skipped' },
      },
      renders: [],
    });
    const report = buildReport({ root: ROOT, result: failed, cliVersion: 'x' });
    expect(report.status).toBe('failed');
    expect(report.failedStep).toBe(0);
    expect(report.formats).toEqual([]);
  });

  it('counts completed_with_warnings as passed and lists each format once', () => {
    const base = result().renders[0];
    if (base === undefined) throw new Error('fixture');
    const report = buildReport({
      root: ROOT,
      result: result({
        status: 'completed_with_warnings',
        warnings: ['slow'],
        renders: [base, { ...base, format: 'gif' }, { ...base, format: 'gif' }],
      }),
      cliVersion: 'x',
    });
    expect(report.status).toBe('passed');
    expect(report.formats).toEqual(['mp4', 'gif']);
    expect(report).not.toHaveProperty('failedStep');
  });
});

describe('isReportOff', () => {
  it.each([
    [{ DEMOFLOW_NO_REPORT: '1' }, true],
    [{ CI: 'true' }, true],
    [{ CI: '' }, false],
    [{ DEMOFLOW_NO_REPORT: '0' }, false],
    [{}, false],
  ])('%j → %s', (env, off) => {
    expect(isReportOff(env)).toBe(off);
  });
});

describe('reportRun', () => {
  let home: string;
  let env: Record<string, string>;
  let host: HostEnvironment;
  let calls: { url: string; init: RequestInit }[];

  const deps = (
    fetchFn: ReportDeps['fetch'],
    extra: Partial<ReportDeps> = {},
  ): ReportDeps => ({
    host,
    fetch: fetchFn,
    version: () => '1.2.3',
    ...extra,
  });
  const ok: ReportDeps['fetch'] = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status: 201 });
  };
  const pair = () =>
    writeCredentials(host, {
      server: 'https://demo.example',
      token: TOKEN,
      runnerId: 'r1',
    });

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'demoflow-report-'));
    env = { XDG_CONFIG_HOME: path.join(home, 'xdg'), APPDATA: home };
    host = { platform: process.platform, env, homedir: home };
    calls = [];
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('posts once to /runner/runs with the Runner token', async () => {
    pair();
    await reportRun({ root: ROOT, result: result() }, deps(ok));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://demo.example/api/runner/runs');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      rootPath: ROOT,
      projectName: 'shop',
      cliVersion: '1.2.3',
    });
  });

  it('sends nothing when the machine is not paired', async () => {
    await reportRun({ root: ROOT, result: result() }, deps(ok));
    expect(calls).toHaveLength(0);
  });

  it.each([
    { CI: 'true' },
    { DEMOFLOW_NO_REPORT: '1' },
  ])('sends nothing with %j', async (extra) => {
    pair();
    host = { ...host, env: { ...env, ...extra } };
    await reportRun({ root: ROOT, result: result() }, deps(ok));
    expect(calls).toHaveLength(0);
  });

  it('is silent when the API rejects the report', async () => {
    pair();
    await expect(
      reportRun(
        { root: ROOT, result: result() },
        deps(async () => new Response('nope', { status: 400 })),
      ),
    ).resolves.toBeUndefined();
  });

  it('is silent when the network fails', async () => {
    pair();
    await expect(
      reportRun(
        { root: ROOT, result: result() },
        deps(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('is silent when credentials.json is malformed', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { credentialsPath } = await import('../../src/auth/credentials.ts');
    mkdirSync(path.dirname(credentialsPath(host)), { recursive: true });
    writeFileSync(credentialsPath(host), '{nope');
    await expect(
      reportRun({ root: ROOT, result: result() }, deps(ok)),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('gives up on a hanging API after the timeout', async () => {
    pair();
    const hang: ReportDeps['fetch'] = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const started = performance.now();
    await reportRun(
      { root: ROOT, result: result() },
      deps(hang, { timeoutMs: 50 }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
