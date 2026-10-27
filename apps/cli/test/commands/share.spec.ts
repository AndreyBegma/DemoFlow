import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fetch } from '../../src/auth/client.ts';
import {
  credentialsPath,
  writeCredentials,
} from '../../src/auth/credentials.ts';
import { CommandError } from '../../src/commands/errors.ts';
import type { Io } from '../../src/commands/io.ts';
import {
  type ShareCommandDeps,
  type ShareFlags,
  shareCommand,
} from '../../src/commands/share.ts';
import {
  type HostEnvironment,
  PROJECT_CONFIG_FILE,
} from '../../src/config/index.ts';
import { main } from '../../src/main.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';

const RUN_ID = '20261026-101500-abcdef';
const SERVER = 'https://demoflow.example';
const TOKEN = 'device-token-123';
const SERVER_RUN_ID = '0d6f4a52-5d0e-4c55-9a7f-3f6f3d5c1a01';
const SHARE_ID = 'share-1';

let dir: string;
let project: string;
let runDir: string;
let host: HostEnvironment;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'demoflow-share-')));
  project = path.join(dir, 'project');
  runDir = path.join(project, 'artifacts', 'runs', RUN_ID);
  host = {
    platform: process.platform,
    env: { XDG_CONFIG_HOME: dir, APPDATA: dir },
    homedir: dir,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(project, PROJECT_CONFIG_FILE),
    JSON.stringify({
      baseUrl: 'http://localhost:3680',
      artifactsDir: 'artifacts',
    }),
  );
  await writeResult(['mp4', 'gif']);
  writeCredentials(host, { server: SERVER, token: TOKEN, runnerId: 'r-1' });
  appendReportedRun(runnerPaths(host).reportedRuns, {
    id: SERVER_RUN_ID,
    runDir,
    at: '2026-10-26T10:15:05.000Z',
    projectId: 'p-1',
    server: SERVER,
    root: project,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeResult(formats: ('mp4' | 'gif' | 'webm')[]) {
  const stage = { status: 'passed' };
  const result = {
    schemaVersion: 1,
    runId: RUN_ID,
    scenarioId: 'demoflow/login.demo.json',
    scenarioName: 'Sign in',
    startedAt: '2026-10-26T10:15:00.000Z',
    finishedAt: '2026-10-26T10:15:05.000Z',
    status: 'completed',
    stages: {
      readiness: stage,
      execution: stage,
      verification: stage,
      recording: stage,
      rendering: stage,
      storage: { status: 'skipped' },
    },
    renders: formats.map((format) => ({
      renderer: 'ffmpeg',
      format,
      file: `render/ffmpeg.${format}`,
      durationMs: 4000,
      sizeBytes: 1000,
      width: 1280,
      height: 720,
      fps: 30,
    })),
    warnings: [],
  } as unknown as RunResult;
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result));
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    url: `${SERVER}/s/abc`,
    fileUrl: `${SERVER}/s/abc/file.mp4`,
    runId: SERVER_RUN_ID,
    projectId: 'p-1',
    title: 'Sign in',
    format: 'mp4',
    status: 'uploading',
    failure: null,
    sizeBytes: 1000,
    width: 1280,
    height: 720,
    durationMs: 4000,
    hasPassword: false,
    views: 0,
    expiresAt: '2026-11-25T10:00:00.000Z',
    createdAt: '2026-10-26T10:00:00.000Z',
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

type Answer = { status: number; body: unknown };

/** The API: the POST answers `post`, each GET the next of `gets` (the last repeats). */
function fakeApi(post: Answer | Answer[], gets: Answer[] = []) {
  const calls: Call[] = [];
  const posts = Array.isArray(post) ? [...post] : [post];
  const fetchFn: Fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: headers.authorization,
      body,
    });
    const answer =
      init?.method === 'POST'
        ? posts.length > 1
          ? posts.shift()
          : posts[0]
        : gets.length > 1
          ? gets.shift()
          : gets[0];
    if (answer === undefined) throw new Error('no answer');
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchFn };
}

function capture(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

function deps(
  fetchFn: Fetch,
  overrides: Partial<ShareCommandDeps> = {},
): ShareCommandDeps {
  let now = 0;
  return {
    host,
    cwd: project,
    fetch: fetchFn,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    askPassword: async () => null,
    ...overrides,
  };
}

async function share(
  fetchFn: Fetch,
  flags: ShareFlags = {},
  overrides: Partial<ShareCommandDeps> = {},
) {
  const io = capture();
  const code = await shareCommand(RUN_ID, flags, io, deps(fetchFn, overrides));
  return { code, ...io };
}

async function refusal(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

describe('demoflow share', () => {
  it('creates the share, waits for it and prints both links', async () => {
    const api = fakeApi({ status: 202, body: view() }, [
      { status: 200, body: view() },
      { status: 200, body: view({ status: 'ready' }) },
    ]);
    const { code, out, err } = await share(api.fetchFn);
    expect(code).toBe(0);
    expect(out).toBe(`${SERVER}/s/abc\n${SERVER}/s/abc/file.mp4\n`);
    expect(err).toContain('Ready; the link works until 2026-11-25');
    expect(api.calls[0]).toEqual({
      method: 'POST',
      url: `${SERVER}/api/runner/shares`,
      authorization: `Bearer ${TOKEN}`,
      body: { runId: SERVER_RUN_ID, format: 'mp4', expiresInDays: 30 },
    });
    expect(api.calls.slice(1).map((call) => call.url)).toEqual([
      `${SERVER}/api/runner/shares/${SHARE_ID}`,
      `${SERVER}/api/runner/shares/${SHARE_ID}`,
    ]);
  });

  it('shares the format and lifetime asked for', async () => {
    const api = fakeApi({ status: 202, body: view({ status: 'ready' }) });
    const { code } = await share(api.fetchFn, {
      format: 'gif',
      expires: '90',
    });
    expect(code).toBe(0);
    expect(api.calls[0]?.body).toEqual({
      runId: SERVER_RUN_ID,
      format: 'gif',
      expiresInDays: 90,
    });
  });

  it('prints the ShareView with --json', async () => {
    const api = fakeApi({ status: 202, body: view({ status: 'ready' }) });
    const { code, out } = await share(api.fetchFn, { json: true });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(view({ status: 'ready' }));
  });

  it('prints no file link for a share with a password', async () => {
    const api = fakeApi({
      status: 202,
      body: view({ status: 'ready', fileUrl: null, hasPassword: true }),
    });
    const { out } = await share(
      api.fetchFn,
      { password: true },
      { askPassword: async () => 'correct horse' },
    );
    expect(out).toBe(`${SERVER}/s/abc\n`);
  });

  it('keeps an existing share and says so', async () => {
    const api = fakeApi(
      { status: 409, body: { error: 'share-exists', shareId: 'share-0' } },
      [{ status: 200, body: view({ id: 'share-0', status: 'ready' }) }],
    );
    const { code, out, err } = await share(api.fetchFn);
    expect(code).toBe(0);
    expect(out).toContain(`${SERVER}/s/abc\n`);
    expect(err).toContain('already shared without a password');
    expect(api.calls[1]?.url).toBe(`${SERVER}/api/runner/shares/share-0`);
  });

  it('asks again when share-exists comes without a share id', async () => {
    const api = fakeApi(
      [
        { status: 409, body: { error: 'share-exists' } },
        { status: 409, body: { error: 'share-exists', shareId: 'share-0' } },
      ],
      [{ status: 200, body: view({ id: 'share-0', status: 'ready' }) }],
    );
    const { code } = await share(api.fetchFn);
    expect(code).toBe(0);
    expect(api.calls.map((call) => call.method)).toEqual([
      'POST',
      'POST',
      'GET',
    ]);
  });

  it('exits 1 with the failure when the upload fails', async () => {
    const api = fakeApi({ status: 202, body: view() }, [
      { status: 200, body: view({ status: 'failed', failure: 'runner-gone' }) },
    ]);
    const { code, out, err } = await share(api.fetchFn);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('The upload failed: runner-gone');
  });

  it('gives up after 10 minutes of uploading', async () => {
    const api = fakeApi({ status: 202, body: view() }, [
      { status: 200, body: view() },
    ]);
    const { code, err } = await share(api.fetchFn);
    expect(code).toBe(1);
    expect(err).toContain('still going after 10 minutes');
    expect(err).toContain('Still uploading (15 s)');
    // One GET a second, for 10 minutes.
    expect(api.calls.length).toBe(1 + 600);
  });

  it('exits 3 when the server is unreachable', async () => {
    const { code, err } = await share(async () => {
      throw new TypeError('fetch failed');
    });
    expect(code).toBe(3);
    expect(err).toContain(`cannot reach ${SERVER}`);
  });

  describe('refusals exit 2 with their code', () => {
    it.each([
      [401, {}, 'not-logged-in'],
      [404, { error: 'not-found' }, 'run-not-reported'],
      [409, { error: 'format-not-rendered' }, 'format-not-rendered'],
      [409, { error: 'artifacts-deleted' }, 'artifacts-deleted'],
      [409, { error: 'runner-offline' }, 'runner-offline'],
      [409, { error: 'runner-outdated' }, 'runner-outdated'],
      [
        413,
        { error: 'file-too-large', maxFileBytes: 200_000_000 },
        'file-too-large',
      ],
      [
        409,
        {
          error: 'quota-exceeded',
          usedBytes: 900_000_000,
          limitBytes: 1_000_000_000,
        },
        'quota-exceeded',
      ],
    ])('%i %j → %s', async (status, body, code) => {
      const api = fakeApi({ status, body });
      const error = await refusal(share(api.fetchFn));
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(2);
    });

    it('names the hint of an offline runner, the size and the quota', async () => {
      const offline = await refusal(
        share(
          fakeApi({ status: 409, body: { error: 'runner-offline' } }).fetchFn,
        ),
      );
      expect(offline.message).toContain('demoflow runner start');
      const outdated = await refusal(
        share(
          fakeApi({ status: 409, body: { error: 'runner-outdated' } }).fetchFn,
        ),
      );
      expect(outdated.message).toContain('restart the runner');
      const large = await refusal(
        share(
          fakeApi({
            status: 413,
            body: { error: 'file-too-large', maxFileBytes: 200_000_000 },
          }).fetchFn,
        ),
      );
      expect(large.message).toContain('200.0 MB');
      const quota = await refusal(
        share(
          fakeApi({
            status: 409,
            body: {
              error: 'quota-exceeded',
              usedBytes: 900_000_000,
              limitBytes: 1_000_000_000,
            },
          }).fetchFn,
        ),
      );
      expect(quota.message).toContain('900.0 MB of 1.00 GB used');
    });

    it('not-logged-in without credentials, before any request', async () => {
      await rm(credentialsPath(host));
      const api = fakeApi({ status: 500, body: {} });
      const error = await refusal(share(api.fetchFn));
      expect(error.code).toBe('not-logged-in');
      expect(error.message).toContain('demoflow login');
      expect(api.calls).toEqual([]);
    });

    it('run-not-found for a missing run directory', async () => {
      const api = fakeApi({ status: 500, body: {} });
      const io = capture();
      const error = await refusal(
        shareCommand('20261026-000000-ffffff', {}, io, deps(api.fetchFn)),
      );
      expect(error.code).toBe('run-not-found');
      expect(api.calls).toEqual([]);
    });

    it('run-not-reported for a run missing from the index', async () => {
      await writeFile(runnerPaths(host).reportedRuns, '');
      const api = fakeApi({ status: 500, body: {} });
      const error = await refusal(share(api.fetchFn));
      expect(error.code).toBe('run-not-reported');
      expect(api.calls).toEqual([]);
    });

    it('run-not-reported for a run reported to another server', async () => {
      writeCredentials(host, {
        server: 'https://staging.example',
        token: TOKEN,
        runnerId: 'r-1',
      });
      const error = await refusal(
        share(fakeApi({ status: 500, body: {} }).fetchFn),
      );
      expect(error.code).toBe('run-not-reported');
      expect(error.message).toContain(SERVER);
    });

    it('format-not-rendered for a format the run lacks, or no render', async () => {
      const api = fakeApi({ status: 500, body: {} });
      const missing = await refusal(share(api.fetchFn, { format: 'webm' }));
      expect(missing.code).toBe('format-not-rendered');
      expect(missing.message).toContain('mp4, gif');
      await writeResult([]);
      const none = await refusal(share(api.fetchFn));
      expect(none.code).toBe('format-not-rendered');
      expect(api.calls).toEqual([]);
    });

    it('invalid-expires for a lifetime the server does not offer', async () => {
      const error = await refusal(
        share(fakeApi({ status: 500, body: {} }).fetchFn, { expires: '14' }),
      );
      expect(error.code).toBe('invalid-expires');
    });
  });

  describe('--password', () => {
    it('sends the typed password in the body only', async () => {
      const api = fakeApi({
        status: 202,
        body: view({ status: 'ready', fileUrl: null, hasPassword: true }),
      });
      await share(
        api.fetchFn,
        { password: true },
        { askPassword: async () => 'typed secret' },
      );
      expect(api.calls[0]?.body?.password).toBe('typed secret');
      expect(api.calls[0]?.url).not.toContain('secret');
    });

    it('reads DEMOFLOW_SHARE_PASSWORD without a terminal', async () => {
      host = {
        ...host,
        env: { ...host.env, DEMOFLOW_SHARE_PASSWORD: 'from the env' },
      };
      const api = fakeApi({
        status: 202,
        body: view({ status: 'ready', fileUrl: null, hasPassword: true }),
      });
      await share(api.fetchFn, { password: true });
      expect(api.calls[0]?.body?.password).toBe('from the env');
    });

    it('is refused without a terminal and without the variable', async () => {
      const api = fakeApi({ status: 500, body: {} });
      const error = await refusal(share(api.fetchFn, { password: true }));
      expect(error.code).toBe('invalid-password');
      expect(error.message).toContain('DEMOFLOW_SHARE_PASSWORD');
      expect(api.calls).toEqual([]);
    });

    it('is refused outside 8–128 characters', async () => {
      const api = fakeApi({ status: 500, body: {} });
      const short = await refusal(
        share(
          api.fetchFn,
          { password: true },
          { askPassword: async () => 'short' },
        ),
      );
      expect(short.code).toBe('invalid-password');
      const long = await refusal(
        share(
          api.fetchFn,
          { password: true },
          { askPassword: async () => 'x'.repeat(129) },
        ),
      );
      expect(long.code).toBe('invalid-password');
    });

    it('takes no value on the command line', async () => {
      const io = capture();
      const code = await main(
        ['share', RUN_ID, '--password', 'hunter2hunter2'],
        io,
      );
      expect(code).toBe(2);
      expect(io.err).toContain('too many arguments');
    });
  });
});
