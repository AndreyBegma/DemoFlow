import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../../src/commands/io.ts';
import type { HostEnvironment } from '../../src/config/platform.ts';
import type { ChildExit, RunChild, SpawnRun } from '../../src/mcp/child.ts';
import {
  type ControlDeps,
  defaultControlDeps,
  runnerStatus,
  statusCommand,
} from '../../src/runner/control.ts';
import {
  EXIT_DAEMON_DONE,
  EXIT_DAEMON_NOT_LOGGED_IN,
  runForeground,
} from '../../src/runner/daemon.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { recordLocalRoot } from '../../src/runner/schedule/local-roots.ts';
import { writeScheduleState } from '../../src/runner/schedule/state.ts';
import { readState } from '../../src/runner/state.ts';
import { FakeClock } from './fakes.ts';

const T0 = Date.parse('2026-10-26T08:00:00.000Z');
const DAY = 86_400_000;

let tmp: string;
let host: HostEnvironment;
let root: string;
let out: string;
let err: string;
let spawned: Array<{ args: string[]; killed: number }>;

const io: Io = {
  stdout: (text) => {
    out += text;
  },
  stderr: (text) => {
    err += text;
  },
};

const spawn: SpawnRun = (args) => {
  let resolve: (exit: ChildExit) => void = () => {};
  const exited = new Promise<ChildExit>((r) => {
    resolve = r;
  });
  const call = { args, killed: 0 };
  spawned.push(call);
  const child: RunChild = {
    pid: 4242,
    exited,
    kill: async () => {
      call.killed++;
      resolve({ code: null, stderrTail: '' });
      await exited;
    },
  };
  return child;
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'demoflow-schedule-daemon-'));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    XDG_CONFIG_HOME: path.join(tmp, '.config'),
    APPDATA: path.join(tmp, 'AppData', 'Roaming'),
  };
  host = { platform: process.platform, env, homedir: tmp };
  root = path.join(tmp, 'shop');
  mkdirSync(root);
  out = '';
  err = '';
  spawned = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function scheduledProject(): void {
  writeFileSync(
    path.join(root, 'demoflow.config.json'),
    JSON.stringify({
      baseUrl: 'http://localhost:1',
      schedule: { cadence: 'daily', at: '09:00' },
    }),
  );
  const paths = runnerPaths(host);
  mkdirSync(paths.dir, { recursive: true });
  recordLocalRoot(paths.localRoots, root);
}

function control(overrides: Partial<ControlDeps> = {}): ControlDeps {
  return { ...defaultControlDeps(), host, ...overrides };
}

function daemon(connects: string[]) {
  return runForeground(io, {
    host,
    pid: process.pid,
    connect: (url) => {
      connects.push(url);
      throw new Error('no socket in local mode');
    },
    clock: new FakeClock(T0),
    random: () => 0.5,
    fetch: () => Promise.reject(new Error('no network in local mode')),
    spawn,
    zone: () => 'UTC',
  });
}

describe('the daemon without an account', () => {
  it('exits as before when no watched root has a schedule', async () => {
    writeFileSync(
      path.join(root, 'demoflow.config.json'),
      '{"baseUrl":"http://localhost:1"}',
    );
    recordLocalRoot(runnerPaths(host).localRoots, root);
    expect(await daemon([])).toBe(EXIT_DAEMON_NOT_LOGGED_IN);
    expect(err).toContain('demoflow login');
  });

  it('runs in local mode: no socket, the due pass runs, status names the mode', async () => {
    scheduledProject();
    const paths = runnerPaths(host);
    writeScheduleState(paths.scheduleState, {
      zone: 'UTC',
      roots: {
        [root]: {
          schedule: { cadence: 'daily', at: '09:00' },
          seenAt: new Date(T0 - 10 * DAY).toISOString(),
          last: { startedAt: new Date(T0 - 3 * DAY).toISOString() },
        },
      },
    });
    const connects: string[] = [];
    const done = daemon(connects);
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(spawned[0]?.args.slice(0, 2)).toEqual(['run', '--check']);
    const state = readState(paths.state);
    expect(state?.state).toBe('local');
    expect(state?.server).toBeUndefined();

    const status = runnerStatus(control());
    expect(status.connection).toBe('local');
    expect(status.schedules).toEqual([
      expect.objectContaining({
        rootPath: root,
        zone: 'UTC',
        lastCheck: { startedAt: '2026-10-26T08:00:00.000Z' },
      }),
    ]);
    expect(status.schedules[0]?.nextCheckAt).not.toBeNull();
    statusCommand({}, io, control());
    expect(out).toContain('Connection: local mode: scheduled checks only');
    expect(out).toContain(`Schedule:   ${root} (daily at 09:00)`);
    expect(out).toContain('last check: 2026-10-26 08:00, no result yet');

    writeFileSync(paths.stop, `${process.pid}\n`);
    expect(await done).toBe(EXIT_DAEMON_DONE);
    expect(connects).toEqual([]);
    expect(spawned[0]?.killed).toBe(1);
  });
});

describe('runner status and schedules', () => {
  it('shows the last check and says the next waits for the runner', () => {
    const paths = runnerPaths(host);
    mkdirSync(paths.dir, { recursive: true });
    writeScheduleState(paths.scheduleState, {
      zone: 'Europe/Berlin',
      roots: {
        [root]: {
          schedule: {
            cadence: 'weekly',
            weekday: 'mon',
            at: '09:30',
            exclude: ['demoflow/wip.demo.json'],
          },
          last: {
            startedAt: '2026-10-26T08:30:00.000Z',
            finishedAt: '2026-10-26T08:41:00.000Z',
            outcome: 'finished',
            passed: 12,
            failed: 1,
          },
        },
        [path.join(tmp, 'gone')]: {
          last: { startedAt: '2026-10-20T08:30:00.000Z' },
        },
      },
    });
    statusCommand({}, io, control());
    expect(out).toContain(
      `Schedule:   ${root} (weekly on mon at 09:30, 1 excluded)`,
    );
    expect(out).toContain('next check: when the runner is running');
    expect(out).toContain('last check: 2026-10-26 09:30, 12 passed, 1 failed');
    expect(out).not.toContain('gone');
    out = '';
    statusCommand({ json: true }, io, control());
    const json = JSON.parse(out) as { schedules: unknown[] };
    expect(json.schedules).toEqual([
      expect.objectContaining({ rootPath: root, nextCheckAt: null }),
    ]);
  });
});
