import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChildExit,
  RunChild,
  SpawnRun,
  SpawnRunOptions,
} from '../../src/mcp/child.ts';
import {
  CHECK_PASS_MAX_MS,
  CHECK_SCENARIO_MAX_MS,
} from '../../src/runner/launch/check.ts';
import { nodeLaunchFs } from '../../src/runner/launch/checks.ts';
import { Launcher, type LauncherDeps } from '../../src/runner/launch/index.ts';
import { LIST_MAX_SCENARIOS } from '../../src/runner/launch/list.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { FakeClock, memoryLogger } from './fakes.ts';

const REQUEST = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

interface Spawned {
  args: string[];
  options: SpawnRunOptions | undefined;
  killed: number;
  exit(code?: number | null): void;
  print(...lines: string[]): void;
}

function fakeSpawn(): { spawn: SpawnRun; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnRun = (args, _cwd, options) => {
    let resolve: (exit: ChildExit) => void = () => {};
    const exited = new Promise<ChildExit>((r) => {
      resolve = r;
    });
    const child: RunChild = {
      pid: 4242,
      exited,
      kill: async () => {
        call.killed++;
        resolve({ code: null, stderrTail: '' });
        await exited;
      },
    };
    const call: Spawned = {
      args,
      options,
      killed: 0,
      exit: (code = 0) => resolve({ code, stderrTail: '' }),
      print: (...lines) => {
        for (const line of lines) options?.onStdoutLine?.(line);
      },
    };
    calls.push(call);
    return child;
  };
  return { spawn, calls };
}

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: (message: Record<string, unknown>) => sent.push(message),
  };
}

let tmp: string;
let root: string;
let indexFile: string;
let clock: FakeClock;
let logger: ReturnType<typeof memoryLogger>;
let spawned: ReturnType<typeof fakeSpawn>;
let reply: ReturnType<typeof recorder>;
let current: ReturnType<typeof recorder>;
let env: Record<string, string | undefined>;

beforeEach(() => {
  tmp = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-launch-check-')),
  );
  root = path.join(tmp, 'shop');
  indexFile = path.join(tmp, 'config', 'reported-runs.jsonl');
  mkdirSync(root);
  writeFileSync(
    path.join(root, 'demoflow.config.json'),
    '{"baseUrl":"http://localhost:1"}',
  );
  clock = new FakeClock();
  logger = memoryLogger();
  spawned = fakeSpawn();
  reply = recorder();
  current = recorder();
  env = {};
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function register(): void {
  appendReportedRun(indexFile, {
    id: 'srv-0',
    runDir: path.join(tmp, 'home', 'runs', 'old'),
    at: '2026-10-23T10:00:00.000Z',
    root,
  });
}

function launcher(overrides: Partial<LauncherDeps> = {}): Launcher {
  return new Launcher({
    indexFile,
    fs: nodeLaunchFs,
    logger,
    clock,
    platform: process.platform,
    env,
    spawn: spawned.spawn,
    loadProject: () => ({ ok: true, home: path.join(tmp, 'home') }),
    newRunId: () => 'local-1',
    readStatus: async () => 'completed',
    ...overrides,
  });
}

function send(target: Launcher, message: Record<string, unknown>): void {
  target.handle(message, reply, current);
}

const checkOf = (extra: Record<string, unknown> = {}) => ({
  type: 'check.start',
  requestId: REQUEST,
  rootPath: root,
  exclude: [],
  ...extra,
});

async function answered(count = 1): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(reply.sent.length).toBeGreaterThanOrEqual(count),
  );
  return reply.sent[count - 1] as Record<string, unknown>;
}

async function finished(): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(current.sent.some((frame) => frame.type === 'check.finished')).toBe(
      true,
    ),
  );
  return current.sent.find((frame) => frame.type === 'check.finished') ?? {};
}

async function started(target: Launcher, extra = {}): Promise<Spawned> {
  register();
  send(target, checkOf(extra));
  expect(await answered()).toEqual({
    type: 'check.started',
    requestId: REQUEST,
  });
  const call = spawned.calls[0];
  if (call === undefined) throw new Error('nothing spawned');
  return call;
}

describe('check.start', () => {
  it('spawns exactly run --check --json --progress --project <root> and the checked excludes', async () => {
    const call = await started(launcher(), {
      exclude: ['demoflow/login.demo.json', 'demoflow/a/b.demo.json'],
    });
    expect(call.args).toEqual([
      'run',
      '--check',
      '--json',
      '--progress',
      '--project',
      root,
      '--exclude',
      'demoflow/login.demo.json',
      '--exclude',
      'demoflow/a/b.demo.json',
    ]);
    call.print(JSON.stringify({ check: true, passed: 3, failed: 1, runs: [] }));
    call.exit(1);
    expect(await finished()).toEqual({
      type: 'check.finished',
      requestId: REQUEST,
      passed: 3,
      failed: 1,
    });
  });

  it.each<[string, boolean, () => Record<string, unknown>, string]>([
    ['an unregistered root', false, () => checkOf(), 'project-unknown'],
    [
      'an extra field',
      true,
      () => checkOf({ scenarioId: 'demoflow/a.demo.json' }),
      'request-invalid',
    ],
    [
      'a root that is not a string',
      true,
      () => checkOf({ rootPath: 42 }),
      'request-invalid',
    ],
    [
      'no exclude',
      true,
      () => ({ type: 'check.start', requestId: REQUEST, rootPath: root }),
      'exclude-invalid',
    ],
    [
      'an exclude id outside demoflow/',
      true,
      () => checkOf({ exclude: ['../a.demo.json'] }),
      'exclude-invalid',
    ],
    [
      'an exclude id that is not a string',
      true,
      () => checkOf({ exclude: [7] }),
      'exclude-invalid',
    ],
    [
      'too many exclude ids',
      true,
      () =>
        checkOf({
          exclude: Array.from(
            { length: LIST_MAX_SCENARIOS + 1 },
            (_, i) => `demoflow/s${i}.demo.json`,
          ),
        }),
      'exclude-invalid',
    ],
  ])('refuses %s with check.error and spawns nothing', async (_why, registered, message, code) => {
    if (registered) register();
    send(launcher(), message());
    expect(await answered()).toEqual({
      type: 'check.error',
      requestId: REQUEST,
      code,
    });
    expect(spawned.calls).toEqual([]);
  });

  it('ignores a check.start with no request id', () => {
    send(launcher(), { ...checkOf(), requestId: 7 });
    expect(reply.sent).toEqual([]);
    expect(logger.text()).toMatch(/ignored a malformed check\.start/);
  });

  it("is the machine's one launch: busy for a run.start, and refused with reporting off", async () => {
    const target = launcher();
    const call = await started(target);
    send(target, {
      type: 'run.start',
      requestId: 'next',
      rootPath: root,
      scenarioId: 'demoflow/a.demo.json',
    });
    expect(await answered(2)).toEqual({
      type: 'run.error',
      requestId: 'next',
      code: 'busy',
    });
    expect(target.running()).toEqual([REQUEST]);
    call.exit(0);
    await finished();

    env.DEMOFLOW_NO_REPORT = '1';
    send(target, { ...checkOf(), requestId: 'off' });
    expect(await answered(3)).toEqual({
      type: 'check.error',
      requestId: 'off',
      code: 'reporting-off',
    });
  });

  it('is cancelled with run.cancel and the same request id', async () => {
    const target = launcher();
    const call = await started(target);
    send(target, { type: 'run.cancel', requestId: REQUEST });
    expect(await finished()).toEqual({
      type: 'check.finished',
      requestId: REQUEST,
      passed: 0,
      failed: 0,
    });
    expect(call.killed).toBe(1);
  });

  it('caps each scenario at 15 minutes: a new scenario restarts the limit', async () => {
    const call = await started(launcher());
    const scenarioLine = (run: number) =>
      JSON.stringify({ type: 'progress', phase: 'check', run, runs: 3 });
    call.print(scenarioLine(1));
    await clock.advance(CHECK_SCENARIO_MAX_MS - 1);
    call.print(scenarioLine(2));
    await clock.advance(CHECK_SCENARIO_MAX_MS - 1);
    expect(call.killed).toBe(0);
    await clock.advance(1);
    expect(call.killed).toBe(1);
    await finished();
  });

  it('caps the whole pass at 2 hours', async () => {
    const call = await started(launcher());
    const step = CHECK_SCENARIO_MAX_MS - 1;
    for (
      let at = 0, run = 1;
      at + step < CHECK_PASS_MAX_MS;
      at += step, run++
    ) {
      call.print(
        JSON.stringify({ type: 'progress', phase: 'check', run, runs: 99 }),
      );
      await clock.advance(step);
      expect(call.killed).toBe(0);
    }
    call.print(
      JSON.stringify({ type: 'progress', phase: 'check', run: 99, runs: 99 }),
    );
    await clock.advance(step);
    expect(call.killed).toBe(1);
    await finished();
  });
});
