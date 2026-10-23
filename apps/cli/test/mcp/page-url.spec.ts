import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HostEnvironment,
  runDir as runDirFor,
} from '../../src/config/index.ts';
import type { ChildExit, RunChild } from '../../src/mcp/child.ts';
import { listDemos } from '../../src/mcp/readonly.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { TaskQueue } from '../../src/mcp/tasks.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';

const SERVER = 'https://demoflow.example';

let dir: string;
let home: string;
let project: string;
let host: HostEnvironment;
let client: Client;
let queue: TaskQueue;
let children: { exit(): void }[];

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-mcp-url-')));
  home = path.join(dir, 'home');
  project = path.join(dir, 'project');
  host = {
    platform: process.platform,
    env: { DEMOFLOW_HOME: home },
    homedir: path.join(dir, 'user'),
  };
  write(path.join(project, 'demoflow.config.json'), '{"baseUrl":"http://x"}');
  children = [];
  queue = new TaskQueue({
    spawn: () => {
      let resolve: (exit: ChildExit) => void = () => undefined;
      const exited = new Promise<ChildExit>((r) => {
        resolve = r;
      });
      const child: RunChild = {
        pid: 1,
        exited,
        kill: async () => resolve({ code: null, stderrTail: '' }),
      };
      children.push({ exit: () => resolve({ code: 0, stderrTail: '' }) });
      return child;
    },
    readResult: async () => resultOf('t1'),
    removeFile: async () => undefined,
    log: () => undefined,
  });
  const server = createMcpServer({ queue, host, cwd: project });
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

function resultOf(runId: string): RunResult {
  const stage = { status: 'passed' };
  return {
    schemaVersion: 1,
    runId,
    scenarioId: 'demoflow/tour.demo.json',
    scenarioName: `Scenario ${runId}`,
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:00:00.000Z',
    status: 'completed',
    stages: {
      readiness: stage,
      execution: stage,
      verification: stage,
      recording: stage,
      rendering: stage,
      storage: stage,
    },
    renders: [],
    warnings: [],
  } as unknown as RunResult;
}

/** A run on disk, as an earlier `demoflow run` left it. */
function runOnDisk(taskId: string): string {
  const runDir = runDirFor(home, taskId, host.platform);
  write(path.join(runDir, 'result.json'), JSON.stringify(resultOf(taskId)));
  return runDir;
}

function report(runDir: string, extra: Record<string, string> = {}): void {
  appendReportedRun(runnerPaths(host).reportedRuns, {
    id: 'srv-1',
    runDir,
    at: '2026-01-01T10:00:00.000Z',
    projectId: 'p/1',
    server: SERVER,
    ...extra,
  });
}

async function getTask(taskId: string): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'get_task',
    arguments: { taskId },
  });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe('get_task pageUrl', () => {
  it('is the run page for a finished task with a full entry', async () => {
    report(runOnDisk('t1'));
    expect((await getTask('t1')).pageUrl).toBe(
      `${SERVER}/app/projects/p%2F1/runs/srv-1`,
    );
  });

  it('is absent without an entry', async () => {
    runOnDisk('t1');
    const view = await getTask('t1');
    expect(view.status).toBe('completed');
    expect(view).not.toHaveProperty('pageUrl');
  });

  it('is absent when the entry has no projectId or no server', async () => {
    const runDir = runOnDisk('t1');
    appendReportedRun(runnerPaths(host).reportedRuns, {
      id: 'srv-1',
      runDir,
      at: '',
    });
    expect(await getTask('t1')).not.toHaveProperty('pageUrl');
  });

  it('is absent for a running task, present once it finished', async () => {
    const runDir = runDirFor(home, 't1', host.platform);
    report(runDir);
    queue.submit({
      taskId: 't1',
      root: project,
      runDir,
      scenarioFile: path.join(project, 'a.demo.json'),
      timeoutMs: 60_000,
    });
    const running = await getTask('t1');
    expect(running.status).toBe('running');
    expect(running).not.toHaveProperty('pageUrl');

    children[0]?.exit();
    await queue.wait('t1', 5_000);
    expect((await getTask('t1')).pageUrl).toBe(
      `${SERVER}/app/projects/p%2F1/runs/srv-1`,
    );
  });

  it('ignores a garbage index', async () => {
    runOnDisk('t1');
    write(runnerPaths(host).reportedRuns, '{not json\n\u0000\n[]\n');
    const view = await getTask('t1');
    expect(view.status).toBe('completed');
    expect(view).not.toHaveProperty('pageUrl');
  });
});

describe('list_demos pageUrl', () => {
  it('is set per entry, and only where the run was reported', async () => {
    report(runOnDisk('a'));
    runOnDisk('b');
    const { demos } = await listDemos({ project }, project, host);
    const byId = Object.fromEntries(demos.map((d) => [d.taskId, d]));
    expect(byId.a?.pageUrl).toBe(`${SERVER}/app/projects/p%2F1/runs/srv-1`);
    expect(byId.b).not.toHaveProperty('pageUrl');
  });

  it('is unchanged by a garbage index', async () => {
    runOnDisk('a');
    write(runnerPaths(host).reportedRuns, 'garbage\n{"id":1}\n');
    const { demos } = await listDemos({ project }, project, host);
    expect(demos.map((d) => d.taskId)).toEqual(['a']);
    expect(demos[0]).not.toHaveProperty('pageUrl');
  });
});
