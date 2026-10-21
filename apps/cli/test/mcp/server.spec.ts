import { spawn } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// Read-only helper of the engine's tests: serves the built fixture on an ephemeral port.
import {
  type FixtureServer,
  startFixtureServer,
} from '../../../../packages/engine/test/execute/fixture-server.ts';

const CLI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const REPO = path.resolve(CLI_DIR, '../..');
const FIXTURE_SCENARIOS = path.join(REPO, 'apps/fixture/demoflow');
const MAIN = path.join(CLI_DIR, 'dist/main.js');
const TERMINAL = ['completed', 'failed', 'cancelled', 'timed_out'];

interface Server {
  client: Client;
  pid: number;
  stderr: () => string;
  close: () => Promise<void>;
}

/** `demoflow mcp` as a real process, through the SDK's own stdio client. */
async function startServer(): Promise<Server> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, 'mcp'],
    cwd: project,
    env: { ...cleanEnv(), DEMOFLOW_HOME: home, FIXTURE_PASSWORD: '' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'demoflow-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    pid: transport.pid as number,
    stderr: () => stderr,
    close: () => client.close(),
  };
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

interface Called {
  isError: boolean;
  value: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent as Record<string, unknown>;
  if (name === 'generate_demo' && typeof value.taskId === 'string') {
    submitted.push({ client, taskId: value.taskId });
  }
  return { isError: result.isError === true, value };
}

/** Every task a test queued: cancelled after it, so none outlives its test. */
const submitted: { client: Client; taskId: string }[] = [];

afterEach(async () => {
  for (const { client, taskId } of submitted.splice(0)) {
    await client
      .callTool({ name: 'cancel_task', arguments: { taskId } })
      .catch(() => undefined); // That server is already closed.
  }
});

async function untilDone(
  client: Client,
  taskId: string,
): Promise<Record<string, unknown>> {
  // Short polls, far under the client's 60 s request timeout.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { value } = await call(client, 'get_task', {
      taskId,
      waitSeconds: 20,
    });
    if (TERMINAL.includes(value.status as string)) return value;
  }
  throw new Error(`task ${taskId} never finished`);
}

/**
 * Resolves with the pid of the task's `demoflow run` child once the server
 * logs its start. The bound is generous: a loaded runner is not what is tested.
 */
async function untilRunning(target: Server, taskId: string): Promise<number> {
  const started = new RegExp(`task ${taskId} started \\(pid (\\d+)\\)`);
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    const match = started.exec(target.stderr());
    if (match !== null) {
      const { value } = await call(target.client, 'get_task', { taskId });
      expect(value.status).toBe('running');
      return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`task ${taskId} never started:\n${target.stderr()}`);
}

/** `process.kill(pid, 0)`: no `ps`, on every OS (ESRCH once the process is gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function untilGone(pids: number[], ms = 30_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (pids.some(alive) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Every file under `dir`, relative: the project tree before and after a run. */
async function listing(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

let fixture: FixtureServer;
let project: string;
let home: string;
let server: Server;

const slowScenario = {
  schemaVersion: 1,
  name: 'Slow',
  steps: [
    { action: 'navigate', path: '/customers' },
    ...Array.from({ length: 15 }, () => ({ action: 'wait', ms: 5_000 })),
  ],
};

beforeAll(async () => {
  // The CLI's own dist is not a dependency of `test` in turbo: build it here.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
      cwd: CLI_DIR,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(build).toBe(0);

  fixture = await startFixtureServer();
  project = await mkdtemp(path.join(tmpdir(), 'demoflow-mcp-project-'));
  home = await mkdtemp(path.join(tmpdir(), 'demoflow-mcp-home-'));
  await writeFile(
    path.join(project, 'demoflow.config.json'),
    JSON.stringify({ baseUrl: fixture.origin }),
  );
  await cp(FIXTURE_SCENARIOS, path.join(project, 'demoflow'), {
    recursive: true,
  });
  await writeFile(
    path.join(project, 'demoflow', 'slow.demo.json'),
    JSON.stringify(slowScenario),
  );
  server = await startServer();
});

afterAll(async () => {
  await server?.close();
  await fixture?.close();
  await Promise.all(
    [project, home].map((dir) =>
      dir === undefined ? undefined : rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe('demoflow mcp', () => {
  it('lists its six tools with input schemas', async () => {
    const { tools } = await server.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cancel_task',
      'check_project',
      'generate_demo',
      'get_task',
      'list_demos',
      'validate_scenario',
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    const generate = tools.find((tool) => tool.name === 'generate_demo');
    const properties = generate?.inputSchema.properties as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(Object.keys(properties).sort()).toEqual([
      'file',
      'formats',
      'project',
      'scenario',
      'timeoutMinutes',
    ]);
    // The scenario schema is the MCP input schema (ADR-0003).
    expect(properties.scenario?.properties).toHaveProperty('steps');
    const getTask = tools.find((tool) => tool.name === 'get_task');
    expect(getTask?.inputSchema.required).toEqual(['taskId']);
  });

  let finished: Record<string, unknown>;

  it('generate_demo with a file returns at once; get_task waits for completed with an MP4', async () => {
    const started = performance.now();
    const { isError, value } = await call(server.client, 'generate_demo', {
      file: 'demoflow/customers.demo.json',
    });
    expect(isError, JSON.stringify(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(value).toMatchObject({ status: 'running', position: 0 });

    finished = await untilDone(server.client, value.taskId as string);
    expect(finished.status, JSON.stringify(finished)).toBe('completed');
    const artifacts = finished.artifacts as Record<string, string>;
    expect(artifacts.runDir).toBe(
      path.join(home, 'runs', value.taskId as string),
    );
    expect(artifacts.video?.endsWith('.mp4')).toBe(true);
    expect(await exists(artifacts.video as string)).toBe(true);
    expect(await exists(artifacts.timeline as string)).toBe(true);
    expect(finished.failedStep).toBeUndefined();
  });

  it('generate_demo with formats renders only those, and get_task lists their paths', async () => {
    const { isError, value } = await call(server.client, 'generate_demo', {
      file: 'demoflow/customers.demo.json',
      formats: ['webm'],
    });
    expect(isError, JSON.stringify(value)).toBe(false);
    const done = await untilDone(server.client, value.taskId as string);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    const artifacts = done.artifacts as {
      runDir: string;
      video?: string;
      videos?: { format: string; path: string }[];
    };
    const webm = path.join(artifacts.runDir, 'render', 'ffmpeg.webm');
    expect(artifacts.videos).toEqual([{ format: 'webm', path: webm }]);
    expect(artifacts.video).toBe(webm);
    expect(await exists(webm)).toBe(true);
    expect(
      await exists(path.join(artifacts.runDir, 'render', 'ffmpeg.mp4')),
    ).toBe(false);
  });

  it('runs an inline scenario, writing only under the home', async () => {
    const before = await listing(project);
    const scenario = JSON.parse(
      await readFile(
        path.join(project, 'demoflow/customers.demo.json'),
        'utf8',
      ),
    );
    const { isError, value } = await call(server.client, 'generate_demo', {
      project,
      scenario,
    });
    expect(isError, JSON.stringify(value)).toBe(false);
    const taskId = value.taskId as string;
    const done = await untilDone(server.client, taskId);
    expect(done.status, JSON.stringify(done)).toBe('completed');

    expect(await listing(project)).toEqual(before);
    const runDir = (done.artifacts as Record<string, string>).runDir as string;
    const result = JSON.parse(
      await readFile(path.join(runDir, 'result.json'), 'utf8'),
    );
    expect(result.scenarioId).toBe(`inline/${taskId}.demo.json`);
    expect(await exists(path.join(runDir, 'scenario.json'))).toBe(true);
    // The staged copy goes once the task ends.
    expect(await exists(path.join(home, 'mcp', `${taskId}.demo.json`))).toBe(
      false,
    );
  });

  it('runs two tasks back to back, never at the same time', async () => {
    const first = await call(server.client, 'generate_demo', {
      file: 'demoflow/customers.demo.json',
    });
    const second = await call(server.client, 'generate_demo', {
      file: 'demoflow/customers.demo.json',
    });
    expect(first.value.status).toBe('running');
    expect(second.value).toMatchObject({ status: 'queued', position: 1 });

    const a = await untilDone(server.client, first.value.taskId as string);
    const b = await untilDone(server.client, second.value.taskId as string);
    expect([a.status, b.status]).toEqual(['completed', 'completed']);
    const times = async (view: Record<string, unknown>) => {
      const runDir = (view.artifacts as Record<string, string>)
        .runDir as string;
      const result = JSON.parse(
        await readFile(path.join(runDir, 'result.json'), 'utf8'),
      );
      return {
        start: Date.parse(result.startedAt),
        end: Date.parse(result.finishedAt),
      };
    };
    expect((await times(b)).start).toBeGreaterThanOrEqual((await times(a)).end);
  });

  it('cancel_task kills a running child; a cancelled queued task never starts', async () => {
    const running = await call(server.client, 'generate_demo', {
      file: 'demoflow/slow.demo.json',
    });
    const queued = await call(server.client, 'generate_demo', {
      file: 'demoflow/slow.demo.json',
    });
    const runningId = running.value.taskId as string;
    const queuedId = queued.value.taskId as string;
    const pid = await untilRunning(server, runningId);

    const cancelledQueued = await call(server.client, 'cancel_task', {
      taskId: queuedId,
    });
    expect(cancelledQueued.value).toEqual({
      taskId: queuedId,
      status: 'cancelled',
    });
    const cancelled = await call(server.client, 'cancel_task', {
      taskId: runningId,
    });
    expect(cancelled.value).toEqual({ taskId: runningId, status: 'cancelled' });
    // cancel_task answers once the child has exited.
    expect(alive(pid)).toBe(false);

    // Unchanged once finished; the queued one never started.
    expect(
      (await call(server.client, 'cancel_task', { taskId: runningId })).value
        .status,
    ).toBe('cancelled');
    expect(await exists(path.join(home, 'runs', queuedId))).toBe(false);
    expect(server.stderr()).not.toContain(`task ${queuedId} started`);
  }, 150_000);

  it('a task past timeoutMinutes is timed_out and its child is gone', async () => {
    const { value } = await call(server.client, 'generate_demo', {
      file: 'demoflow/slow.demo.json',
      timeoutMinutes: 1,
    });
    const taskId = value.taskId as string;
    const pid = await untilRunning(server, taskId);
    const done = await untilDone(server.client, taskId);
    expect(done.status).toBe('timed_out');
    expect(alive(pid)).toBe(false);
  }, 240_000);

  it('invalid input returns { code, message, hint }', async () => {
    const scenario = {
      schemaVersion: 1,
      name: 'Bad',
      steps: [{ action: 'click' }],
    };
    const invalid = await call(server.client, 'generate_demo', { scenario });
    expect(invalid.isError).toBe(true);
    expect(invalid.value).toMatchObject({ code: 'invalid-scenario' });
    expect(typeof invalid.value.message).toBe('string');
    expect(typeof invalid.value.hint).toBe('string');
    const issues = invalid.value.issues as { path: string }[];
    expect(issues.some((issue) => issue.path.startsWith('steps[0]'))).toBe(
      true,
    );

    const outside = await call(server.client, 'generate_demo', {
      file: '../elsewhere.demo.json',
    });
    expect(outside.value.code).toBe('file-not-in-project');

    const both = await call(server.client, 'generate_demo', {
      file: 'demoflow/customers.demo.json',
      scenario: slowScenario,
    });
    expect(both.value.code).toBe('both-or-neither-scenario');
    const neither = await call(server.client, 'generate_demo', {});
    expect(neither.value.code).toBe('both-or-neither-scenario');

    for (const formats of [[], ['gif', 'gif'], ['avi']]) {
      const bad = await call(server.client, 'generate_demo', {
        file: 'demoflow/customers.demo.json',
        formats,
      });
      expect(bad.isError, JSON.stringify(formats)).toBe(true);
      expect(typeof bad.value.code).toBe('string');
    }

    const unknown = await call(server.client, 'get_task', {
      taskId: '20200101-000000-nosuch',
    });
    expect(unknown.value.code).toBe('task-not-found');
    const traversal = await call(server.client, 'get_task', {
      taskId: '../runs',
    });
    expect(traversal.value.code).toBe('task-not-found');

    // Capped at 50 s: headroom under a 60 s client request timeout.
    const tooLong = await call(server.client, 'get_task', {
      taskId: '20200101-000000-nosuch',
      waitSeconds: 51,
    });
    expect(tooLong.value.code).toBe('invalid-input');
    expect((tooLong.value.issues as { path: string }[])[0]?.path).toBe(
      'waitSeconds',
    );

    const missing = await call(server.client, 'generate_demo', {
      project: path.join(tmpdir(), 'demoflow-no-such-project'),
      file: 'a.demo.json',
    });
    expect(missing.value.code).toBe('project-not-found');
  });

  it('after a restart get_task reads a finished task back from disk', async () => {
    await server.close();
    server = await startServer();
    const again = await call(server.client, 'get_task', {
      taskId: finished.taskId,
    });
    expect(again.isError).toBe(false);
    expect(again.value).toEqual(finished);
  });

  it('closing stdin stops the server and leaves no child behind', async () => {
    const own = await startServer();
    const { value } = await call(own.client, 'generate_demo', {
      file: 'demoflow/slow.demo.json',
    });
    const pid = await untilRunning(own, value.taskId as string);
    // The SDK client ends the server's stdin, then waits for it to leave.
    await own.close();
    await untilGone([own.pid, pid]);
    expect(alive(own.pid)).toBe(false);
    expect(own.stderr()).toContain('stopped (stdin closed)');
    expect(alive(pid)).toBe(false);
  }, 150_000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM stops the server and leaves no child behind',
    async () => {
      const own = await startServer();
      const { value } = await call(own.client, 'generate_demo', {
        file: 'demoflow/slow.demo.json',
      });
      const pid = await untilRunning(own, value.taskId as string);
      process.kill(own.pid, 'SIGTERM');
      await untilGone([own.pid, pid]);
      expect(alive(own.pid)).toBe(false);
      expect(own.stderr()).toContain('stopped (SIGTERM)');
      expect(alive(pid)).toBe(false);
      await own.close();
    },
    150_000,
  );
});
