import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fetch } from '../../src/auth/client.ts';
import { writeCredentials } from '../../src/auth/credentials.ts';
import {
  type HostEnvironment,
  runDir as runDirFor,
} from '../../src/config/index.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { TaskQueue } from '../../src/mcp/tasks.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';

const SERVER = 'https://demoflow.example';
const TOKEN = 'device-token-123';
const TASK_ID = 't1';
const SERVER_RUN_ID = '0d6f4a52-5d0e-4c55-9a7f-3f6f3d5c1a01';

let dir: string;
let home: string;
let project: string;
let runDir: string;
let host: HostEnvironment;
let client: Client;
let queue: TaskQueue;
let calls: { method: string; url: string; body: unknown }[];
let gets: { status: number; body: unknown }[];
let post: { status: number; body: unknown };

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-mcp-share-')));
  home = path.join(dir, 'home');
  project = path.join(dir, 'project');
  host = {
    platform: process.platform,
    env: { DEMOFLOW_HOME: home, XDG_CONFIG_HOME: dir, APPDATA: dir },
    homedir: path.join(dir, 'user'),
  };
  config({ share: { allowMcp: true } });
  runDir = runDirFor(home, TASK_ID, host.platform);
  write(path.join(runDir, 'result.json'), JSON.stringify(result()));
  writeCredentials(host, { server: SERVER, token: TOKEN, runnerId: 'r-1' });
  report({ root: project });

  calls = [];
  post = { status: 202, body: view({ status: 'ready' }) };
  gets = [];
  const fetchFn: Fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const answer =
      init?.method === 'POST' ? post : gets.length > 1 ? gets.shift() : gets[0];
    return new Response(JSON.stringify(answer?.body ?? {}), {
      status: answer?.status ?? 500,
    });
  };
  let now = 0;
  queue = new TaskQueue({
    spawn: () => {
      throw new Error('no runs here');
    },
    readResult: async () => {
      throw new Error('no runs here');
    },
    removeFile: async () => undefined,
    log: () => undefined,
  });
  const server = createMcpServer({
    queue,
    host,
    cwd: project,
    share: {
      fetch: fetchFn,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await queue.close();
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function config(extra: Record<string, unknown>): void {
  write(
    path.join(project, 'demoflow.config.json'),
    JSON.stringify({ baseUrl: 'http://x', ...extra }),
  );
}

function report(extra: { root?: string }): void {
  appendReportedRun(runnerPaths(host).reportedRuns, {
    id: SERVER_RUN_ID,
    runDir,
    at: '2026-10-26T10:15:05.000Z',
    projectId: 'p-1',
    server: SERVER,
    ...extra,
  });
}

function result() {
  const stage = { status: 'passed' };
  return {
    schemaVersion: 1,
    runId: TASK_ID,
    scenarioId: 'demoflow/tour.demo.json',
    scenarioName: 'Tour',
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
    renders: ['mp4', 'gif'].map((format) => ({
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
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-1',
    url: `${SERVER}/s/abc`,
    fileUrl: `${SERVER}/s/abc/file.mp4`,
    status: 'uploading',
    failure: null,
    hasPassword: false,
    expiresAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
  };
}

async function shareDemo(args: Record<string, unknown> = {}) {
  const answer = await client.callTool({
    name: 'share_demo',
    arguments: { runId: TASK_ID, ...args },
  });
  return {
    isError: answer.isError === true,
    content: answer.structuredContent as Record<string, unknown>,
  };
}

describe('share_demo', () => {
  it('creates the share when the project allows it', async () => {
    const { isError, content } = await shareDemo();
    expect(isError).toBe(false);
    expect(content).toEqual({
      shareId: 'share-1',
      url: `${SERVER}/s/abc`,
      fileUrl: `${SERVER}/s/abc/file.mp4`,
      expiresAt: '2026-11-25T10:00:00.000Z',
      status: 'ready',
      existing: false,
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${SERVER}/api/runner/shares`,
        body: { runId: SERVER_RUN_ID, format: 'mp4', expiresInDays: 30 },
      },
    ]);
  });

  it('passes the format and lifetime, and never a password', async () => {
    await shareDemo({ format: 'gif', expiresInDays: 7 });
    expect(calls[0]?.body).toEqual({
      runId: SERVER_RUN_ID,
      format: 'gif',
      expiresInDays: 7,
    });
  });

  it.each([
    ['without a share block', {}],
    ['with allowMcp false', { share: { allowMcp: false } }],
  ])('is share-not-allowed %s', async (_name, extra) => {
    config(extra);
    const { isError, content } = await shareDemo();
    expect(isError).toBe(true);
    expect(content.code).toBe('share-not-allowed');
    expect(content.hint).toContain('"allowMcp": true');
    expect(calls).toEqual([]);
  });

  it('is share-not-allowed for a run reported without a root', async () => {
    rmSync(runnerPaths(host).reportedRuns);
    report({});
    const { content } = await shareDemo();
    expect(content.code).toBe('share-not-allowed');
    expect(calls).toEqual([]);
  });

  it('is share-not-allowed when the config cannot be read', async () => {
    write(path.join(project, 'demoflow.config.json'), '{not json');
    const { content } = await shareDemo();
    expect(content.code).toBe('share-not-allowed');
  });

  it('waits for the upload, then answers uploading', async () => {
    post = { status: 202, body: view() };
    gets = [{ status: 200, body: view() }];
    const { isError, content } = await shareDemo();
    expect(isError).toBe(false);
    expect(content.status).toBe('uploading');
    // One GET a second, under the 60 s request timeout of MCP clients.
    expect(calls.filter((call) => call.method === 'GET').length).toBe(50);
  });

  it('returns an existing share', async () => {
    post = { status: 409, body: { error: 'share-exists', shareId: 'share-0' } };
    gets = [{ status: 200, body: view({ id: 'share-0', status: 'ready' }) }];
    const { content } = await shareDemo();
    expect(content.shareId).toBe('share-0');
    expect(content.existing).toBe(true);
  });

  it('is share-failed when the upload fails', async () => {
    post = { status: 202, body: view() };
    gets = [{ status: 200, body: view({ status: 'failed', failure: 'io' }) }];
    const { isError, content } = await shareDemo();
    expect(isError).toBe(true);
    expect(content.code).toBe('share-failed');
    expect(content.message).toContain('io');
  });

  it('names the server refusal with a hint', async () => {
    post = { status: 409, body: { error: 'runner-offline' } };
    const { content } = await shareDemo();
    expect(content.code).toBe('runner-offline');
    expect(content.hint).toContain('demoflow runner start');
  });

  it('is not-logged-in without credentials', async () => {
    rmSync(path.join(runnerPaths(host).dir, 'credentials.json'));
    const { content } = await shareDemo();
    expect(content.code).toBe('not-logged-in');
    expect(calls).toEqual([]);
  });

  it('is run-not-reported for a run missing from the index', async () => {
    rmSync(runnerPaths(host).reportedRuns);
    const { content } = await shareDemo();
    expect(content.code).toBe('run-not-reported');
  });

  it('is task-not-found for an unknown run', async () => {
    const { content } = await shareDemo({ runId: 'nope' });
    expect(content.code).toBe('task-not-found');
  });

  it('is invalid-input for a lifetime the server does not offer', async () => {
    const { content } = await shareDemo({ expiresInDays: 14 });
    expect(content.code).toBe('invalid-input');
  });
});
