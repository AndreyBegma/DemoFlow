import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScheduleConfig } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChildExit,
  RunChild,
  SpawnRun,
  SpawnRunOptions,
} from '../../src/mcp/child.ts';
import { nodeLaunchFs } from '../../src/runner/launch/checks.ts';
import { Launcher } from '../../src/runner/launch/index.ts';
import {
  LOCAL_ROOTS_KEEP,
  readLocalRoots,
  recordLocalRoot,
} from '../../src/runner/schedule/local-roots.ts';
import {
  Scheduler,
  type SchedulerDeps,
  type SchedulesSync,
} from '../../src/runner/schedule/scheduler.ts';
import {
  readScheduleState,
  writeScheduleState,
} from '../../src/runner/schedule/state.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { FakeClock, memoryLogger } from './fakes.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Monday, an hour before the 09:00 slot. */
const T0 = Date.parse('2026-10-26T08:00:00.000Z');
const DAILY: ScheduleConfig = { cadence: 'daily', at: '09:00' };
const REQUEST = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

interface Spawned {
  args: string[];
  cwd: string;
  options: SpawnRunOptions | undefined;
  killed: number;
  exit(code?: number | null): void;
  print(...lines: string[]): void;
}

function fakeSpawn(): { spawn: SpawnRun; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnRun = (args, cwd, options) => {
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
      cwd,
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

let tmp: string;
let root: string;
let stateFile: string;
let clock: FakeClock;
let logger: ReturnType<typeof memoryLogger>;
let spawned: ReturnType<typeof fakeSpawn>;
let schedules: Map<string, ScheduleConfig | Error>;
let reported: string[];
let local: string[];
let frames: SchedulesSync[];
let running: Scheduler[];

beforeEach(() => {
  tmp = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-schedule-')),
  );
  root = path.join(tmp, 'shop');
  mkdirSync(root);
  stateFile = path.join(tmp, 'schedule.state.json');
  clock = new FakeClock(T0);
  logger = memoryLogger();
  spawned = fakeSpawn();
  schedules = new Map([[root, DAILY]]);
  reported = [];
  local = [root];
  frames = [];
  running = [];
});
afterEach(async () => {
  for (const scheduler of running) await scheduler.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function scheduler(overrides: Partial<SchedulerDeps> = {}): Scheduler {
  const created = new Scheduler({
    clock,
    logger,
    zone: () => 'UTC',
    roots: () => ({ reported, local }),
    loadSchedule: (at) => {
      const schedule = schedules.get(at);
      if (schedule instanceof Error) throw schedule;
      return schedule;
    },
    stateFile,
    spawn: spawned.spawn,
    claim: () => () => {},
    onSchedules: (frame) => frames.push(frame),
    ...overrides,
  });
  running.push(created);
  return created;
}

const totals = (passed: number, failed: number) =>
  JSON.stringify({ check: true, passed, failed });

describe('the scheduler', () => {
  it('spawns exactly one check pass when the slot passes while it runs', async () => {
    scheduler().start();
    expect(spawned.calls).toHaveLength(0);
    await clock.advance(HOUR - 1);
    expect(spawned.calls).toHaveLength(0);
    await clock.advance(1);
    expect(spawned.calls).toHaveLength(1);
    const [pass] = spawned.calls;
    expect(pass?.args).toEqual([
      'run',
      '--check',
      '--json',
      '--progress',
      '--project',
      root,
    ]);
    expect(pass?.cwd).toBe(root);
    // Written before the spawn: a crash now does not repeat the slot.
    expect(readScheduleState(stateFile)?.roots[root]?.last).toEqual({
      startedAt: '2026-10-26T09:00:00.000Z',
    });
    await clock.advance(10 * MINUTE);
    expect(spawned.calls).toHaveLength(1);
    pass?.print(totals(3, 1));
    pass?.exit(0);
    await clock.advance(22 * HOUR);
    expect(spawned.calls).toHaveLength(1);
    expect(readScheduleState(stateFile)?.roots[root]?.last).toEqual({
      startedAt: '2026-10-26T09:00:00.000Z',
      finishedAt: '2026-10-26T09:10:00.000Z',
      outcome: 'finished',
      passed: 3,
      failed: 1,
    });
    expect(logger.text()).toContain('shop: finished, 3 passed, 1 failed');
    expect(logger.text()).not.toContain(tmp);
  });

  it('runs one catch-up pass, not three, three days after the last one', async () => {
    writeScheduleState(stateFile, {
      zone: 'UTC',
      roots: {
        [root]: {
          schedule: DAILY,
          seenAt: new Date(T0 - 10 * DAY).toISOString(),
          last: { startedAt: new Date(T0 - 3 * DAY + HOUR).toISOString() },
        },
      },
    });
    scheduler().start();
    expect(spawned.calls).toHaveLength(1);
    spawned.calls[0]?.exit(0);
    await clock.advance(50 * MINUTE);
    expect(spawned.calls).toHaveLength(1);
  });

  it('does not fire for a slot before it first saw the schedule', async () => {
    clock = new FakeClock(T0 + 3 * HOUR);
    scheduler().start();
    await clock.advance(MINUTE);
    expect(spawned.calls).toHaveLength(0);
    expect(readScheduleState(stateFile)?.roots[root]?.seenAt).toBe(
      '2026-10-26T11:00:00.000Z',
    );
  });

  it('passes the excluded scenario ids', async () => {
    schedules.set(root, {
      ...DAILY,
      exclude: ['demoflow/wip.demo.json', 'demoflow/a/b.demo.json'],
    });
    scheduler().start();
    await clock.advance(HOUR);
    expect(spawned.calls[0]?.args.slice(6)).toEqual([
      '--exclude',
      'demoflow/wip.demo.json',
      '--exclude',
      'demoflow/a/b.demo.json',
    ]);
  });

  it('runs one pass at a time', async () => {
    const other = path.join(tmp, 'blog');
    schedules.set(other, DAILY);
    local = [root, other];
    scheduler().start();
    await clock.advance(HOUR);
    expect(spawned.calls).toHaveLength(1);
    spawned.calls[0]?.exit(0);
    await clock.advance(1);
    expect(spawned.calls).toHaveLength(2);
    expect(new Set(spawned.calls.map((call) => call.cwd))).toEqual(
      new Set([root, other]),
    );
  });

  it('kills a pass that outlives the pass cap and records it timed-out', async () => {
    scheduler().start();
    await clock.advance(HOUR);
    await clock.advance(2 * HOUR);
    expect(spawned.calls[0]?.killed).toBe(1);
    expect(readScheduleState(stateFile)?.roots[root]?.last?.outcome).toBe(
      'timed-out',
    );
  });

  it('kills the running pass on stop', async () => {
    const created = scheduler();
    created.start();
    await clock.advance(HOUR);
    await created.stop();
    expect(spawned.calls[0]?.killed).toBe(1);
    expect(readScheduleState(stateFile)?.roots[root]?.last?.outcome).toBe(
      'cancelled',
    );
  });

  it('skips a root whose config does not load and logs it once', async () => {
    schedules.set(root, new Error(`${root}/demoflow.config.json is invalid`));
    scheduler().start();
    await clock.advance(2 * HOUR);
    expect(spawned.calls).toHaveLength(0);
    const warnings = logger.lines.filter((line) =>
      line.message.includes('does not load'),
    );
    expect(warnings).toHaveLength(1);
    expect(logger.text()).not.toContain(tmp);
  });

  it('forgets a removed schedule, so adding it back starts fresh', async () => {
    const created = scheduler();
    created.start();
    schedules.delete(root);
    await clock.advance(2 * HOUR);
    expect(spawned.calls).toHaveLength(0);
    expect(readScheduleState(stateFile)?.roots[root]).toBeUndefined();
  });
});

describe('the scheduler and website launches', () => {
  it('starts no pass while a launch runs, and starts it when the launch ends', async () => {
    const indexFile = path.join(tmp, 'reported-runs.jsonl');
    writeFileSync(
      path.join(root, 'demoflow.config.json'),
      '{"baseUrl":"http://localhost:1"}',
    );
    appendReportedRun(indexFile, {
      id: 'srv-0',
      runDir: path.join(tmp, 'home', 'runs', 'old'),
      at: '2026-10-23T10:00:00.000Z',
      root,
    });
    const replies: Array<Record<string, unknown>> = [];
    const reply = {
      send: (message: Record<string, unknown>) => replies.push(message),
    };
    let created: Scheduler | null = null;
    const launcher = new Launcher({
      indexFile,
      fs: nodeLaunchFs,
      logger,
      clock,
      platform: process.platform,
      env: {},
      spawn: spawned.spawn,
      loadProject: () => ({ ok: true, home: path.join(tmp, 'home') }),
      newRunId: () => 'local-1',
      readStatus: async () => 'completed',
      onIdle: () => created?.wake(),
    });
    created = scheduler({ claim: () => launcher.claim() });
    created.start();
    await clock.advance(HOUR - 5 * MINUTE);
    const check = {
      type: 'check.start',
      requestId: REQUEST,
      rootPath: root,
      exclude: [],
    };
    launcher.handle(check, reply, reply);
    // The launcher checks the root on disk before it spawns.
    await vi.waitFor(() => expect(spawned.calls).toHaveLength(1));
    await clock.advance(10 * MINUTE);
    // The slot passed at 09:00; the website's pass still holds the launch slot.
    expect(spawned.calls).toHaveLength(1);
    spawned.calls[0]?.print(totals(1, 0));
    spawned.calls[0]?.exit(0);
    await clock.advance(1);
    expect(spawned.calls).toHaveLength(2);
    // And while the scheduled pass runs, the website is told `busy`.
    launcher.handle(
      { ...check, requestId: `${REQUEST.slice(0, -1)}0` },
      reply,
      reply,
    );
    expect(replies.at(-1)).toMatchObject({ type: 'check.error', code: 'busy' });
    expect(spawned.calls).toHaveLength(2);
    spawned.calls[1]?.exit(0);
    await clock.advance(1);
    await launcher.close();
  });
});

describe('schedules.sync', () => {
  it('names only reported roots, with the schedule as parsed or null, and the zone', async () => {
    const blog = path.join(tmp, 'blog');
    const docs = path.join(tmp, 'docs');
    reported = [root, blog];
    local = [docs];
    schedules.set(docs, DAILY);
    const created = scheduler({ zone: () => 'Europe/Berlin' });
    created.start();
    const expected: SchedulesSync = {
      type: 'schedules.sync',
      zone: 'Europe/Berlin',
      projects: [
        { rootPath: blog, schedule: null },
        { rootPath: root, schedule: DAILY },
      ],
    };
    expect(frames).toEqual([expected]);
    expect(created.schedules()).toEqual(expected);
    // Unchanged on the next tick: nothing new is sent.
    await clock.advance(MINUTE);
    expect(frames).toHaveLength(1);
    const weekly: ScheduleConfig = {
      cadence: 'weekly',
      weekday: 'fri',
      at: '18:00',
    };
    schedules.set(blog, weekly);
    await clock.advance(MINUTE);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.projects[0]).toEqual({
      rootPath: blog,
      schedule: weekly,
    });
  });
});

describe('local-roots.jsonl', () => {
  it('records each root once, oldest first', () => {
    const file = path.join(tmp, 'runner', 'local-roots.jsonl');
    recordLocalRoot(file, '/a');
    recordLocalRoot(file, '/b');
    recordLocalRoot(file, '/a');
    expect(readLocalRoots(file)).toEqual(['/a', '/b']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it(`keeps the last ${LOCAL_ROOTS_KEEP} roots`, () => {
    const file = path.join(tmp, 'local-roots.jsonl');
    writeFileSync(
      file,
      Array.from(
        { length: LOCAL_ROOTS_KEEP },
        (_, i) => `${JSON.stringify({ root: `/r${i}` })}\n`,
      ).join(''),
    );
    recordLocalRoot(file, '/new');
    const roots = readLocalRoots(file);
    expect(roots).toHaveLength(LOCAL_ROOTS_KEEP);
    expect(roots[0]).toBe('/r1');
    expect(roots.at(-1)).toBe('/new');
  });

  it('skips malformed lines and never throws on a missing file', () => {
    const file = path.join(tmp, 'local-roots.jsonl');
    expect(readLocalRoots(file)).toEqual([]);
    writeFileSync(file, 'nope\n{"root":""}\n{"root":"/a"}\n[1]\n');
    expect(readLocalRoots(file)).toEqual(['/a']);
  });
});
