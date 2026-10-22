import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialsPath,
  writeCredentials,
} from '../../src/auth/credentials.ts';
import type { HostEnvironment } from '../../src/config/index.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import {
  buildReport,
  isReportOff,
  type ReportDeps,
  reportRun,
} from '../../src/runs-report/report.ts';
import {
  appendReportedRun,
  findReportedRun,
  INDEX_KEEP_LINES,
  INDEX_MAX_BYTES,
} from '../../src/runs-report/reported-runs.ts';

const TOKEN = 'dfr_secret-token-value';
const ROOT = path.join(path.sep, 'work', 'shop');
const RUN_DIR = path.resolve(path.sep, 'home', 'dev', '.demoflow', 'runs', 'r');

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
    return Response.json({ runId: 'srv-1' }, { status: 201 });
  };
  const input = () => ({ root: ROOT, runDir: RUN_DIR, result: result() });
  const index = () => runnerPaths(host).reportedRuns;
  const indexLines = (): unknown[] =>
    existsSync(index())
      ? readFileSync(index(), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line))
      : [];
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
    await reportRun(input(), deps(ok));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://demo.example/api/runner/runs');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      rootPath: path.resolve(ROOT),
      projectName: 'shop',
      cliVersion: '1.2.3',
    });
  });

  it('sends the canonical root: a symlinked folder is the same project', async () => {
    pair();
    const real = path.join(home, 'real');
    const link = path.join(home, 'link');
    mkdirSync(real);
    // A junction needs no privilege on Windows; POSIX ignores the type.
    symlinkSync(real, link, 'junction');
    await reportRun({ ...input(), root: link }, deps(ok));
    await reportRun({ ...input(), root: real }, deps(ok));
    const roots = calls.map(
      (call) => JSON.parse(String(call.init.body)).rootPath,
    );
    expect(roots).toEqual([
      realpathSync.native(real),
      realpathSync.native(real),
    ]);
  });

  it('sends nothing when the machine is not paired', async () => {
    await reportRun(input(), deps(ok));
    expect(calls).toHaveLength(0);
  });

  it.each([
    { CI: 'true' },
    { DEMOFLOW_NO_REPORT: '1' },
  ])('sends nothing with %j', async (extra) => {
    pair();
    host = { ...host, env: { ...env, ...extra } };
    await reportRun(input(), deps(ok));
    expect(calls).toHaveLength(0);
  });

  it('is silent when the API rejects the report', async () => {
    pair();
    await expect(
      reportRun(
        input(),
        deps(async () => new Response('nope', { status: 400 })),
      ),
    ).resolves.toBeUndefined();
  });

  it('is silent when the network fails', async () => {
    pair();
    await expect(
      reportRun(
        input(),
        deps(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('is silent when credentials.json is malformed', async () => {
    mkdirSync(path.dirname(credentialsPath(host)), { recursive: true });
    writeFileSync(credentialsPath(host), '{nope');
    await expect(reportRun(input(), deps(ok))).resolves.toBeUndefined();
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
    await reportRun(input(), deps(hang, { timeoutMs: 50 }));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(indexLines()).toEqual([]);
  });

  it('records a run the server took, with its run directory', async () => {
    pair();
    await reportRun(input(), deps(ok));
    const lines = indexLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      id: 'srv-1',
      runDir: RUN_DIR,
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(path.dirname(index())).toBe(path.dirname(credentialsPath(host)));
  });

  const answers: Array<[string, ReportDeps['fetch']]> = [
    ['a 4xx', async () => new Response('nope', { status: 400 })],
    ['a 5xx', async () => Response.json({ runId: 'x' }, { status: 500 })],
    ['no run id', async () => Response.json({}, { status: 201 })],
    [
      'an empty run id',
      async () => Response.json({ runId: '' }, { status: 201 }),
    ],
    [
      'a body that is not JSON',
      async () => new Response('<html>', { status: 201 }),
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ];
  it.each(answers)('records nothing after %s', async (_name, fetchFn) => {
    pair();
    await expect(reportRun(input(), deps(fetchFn))).resolves.toBeUndefined();
    expect(indexLines()).toEqual([]);
  });

  it('records nothing when the body never finishes within the timeout', async () => {
    pair();
    const stalled: ReportDeps['fetch'] = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"runId":'));
            init?.signal?.addEventListener('abort', () =>
              controller.error(new Error('aborted')),
            );
          },
        }),
        { status: 201 },
      );
    await reportRun(input(), deps(stalled, { timeoutMs: 50 }));
    expect(indexLines()).toEqual([]);
  });

  it.each([
    ['CI', { CI: 'true' }],
    ['DEMOFLOW_NO_REPORT', { DEMOFLOW_NO_REPORT: '1' }],
  ])('records nothing with %s', async (_name, extra) => {
    pair();
    host = { ...host, env: { ...env, ...extra } };
    await reportRun(input(), deps(ok));
    expect(indexLines()).toEqual([]);
  });

  it('records nothing on a machine that is not paired', async () => {
    await reportRun(input(), deps(ok));
    expect(indexLines()).toEqual([]);
  });
});

describe('reported-runs.jsonl', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'demoflow-index-'));
    file = path.join(dir, 'reported-runs.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (id: string, runDir = path.join(dir, id)) => ({
    id,
    runDir,
    at: '2026-10-22T10:00:00.000Z',
  });

  it('finds nothing when there is no index', async () => {
    await expect(findReportedRun(file, 'a')).resolves.toBeNull();
  });

  it('lets the last entry with an id win', async () => {
    appendReportedRun(file, entry('a', 'first'));
    appendReportedRun(file, entry('b'));
    appendReportedRun(file, entry('a', 'second'));
    await expect(findReportedRun(file, 'a')).resolves.toMatchObject({
      runDir: 'second',
    });
    await expect(findReportedRun(file, 'c')).resolves.toBeNull();
  });

  it('skips malformed lines', async () => {
    appendReportedRun(file, entry('a', 'good'));
    appendFileSync(
      file,
      [
        '{nope',
        '[]',
        'null',
        JSON.stringify({ id: 'a' }),
        JSON.stringify({ id: 'a', runDir: 7 }),
        JSON.stringify({ id: 'a', runDir: '' }),
        '',
      ].join('\n'),
    );
    await expect(findReportedRun(file, 'a')).resolves.toMatchObject({
      runDir: 'good',
    });
  });

  it('keeps the last 2,000 lines once the file passes 1 MiB', async () => {
    // ~470 bytes a line: past 1 MiB with more than 2,000 lines to drop from.
    const pad = 'x'.repeat(400);
    const lines: string[] = [];
    for (let i = 0; byteLength(lines) <= INDEX_MAX_BYTES; i++) {
      lines.push(JSON.stringify(entry(`old-${i}`, pad)));
    }
    expect(lines.length).toBeGreaterThan(INDEX_KEEP_LINES);
    writeFileSync(file, `${lines.join('\n')}\n`);
    appendReportedRun(file, entry('new'));
    const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(kept).toHaveLength(INDEX_KEEP_LINES + 1);
    expect(kept[0]).toBe(lines[lines.length - INDEX_KEEP_LINES]);
    expect(JSON.parse(kept.at(-1) ?? '')).toMatchObject({ id: 'new' });
    expect(statSync(file).size).toBeLessThan(INDEX_MAX_BYTES * 2);
    await expect(findReportedRun(file, 'old-0')).resolves.toBeNull();
  });

  it('leaves a file under 1 MiB alone', () => {
    for (let i = 0; i < INDEX_KEEP_LINES + 10; i++) {
      appendReportedRun(file, entry(`r${i}`));
    }
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(
      INDEX_KEEP_LINES + 10,
    );
  });
});

/** The size of `lines` written one per line, all ASCII. */
function byteLength(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}
