import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialsPath } from '../../src/auth/credentials.ts';
import type { Io } from '../../src/commands/io.ts';
import { type HostEnvironment, pathFor } from '../../src/config/platform.ts';
import {
  type ControlDeps,
  defaultControlDeps,
  formatDuration,
  logsCommand,
  runnerStatus,
  stopRunner,
} from '../../src/runner/control.ts';
import { acquireLock, readLock, releaseLock } from '../../src/runner/lock.ts';
import { fileLogger, redact } from '../../src/runner/log.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { readState, writeState } from '../../src/runner/state.ts';

let tmp: string;
let host: HostEnvironment;
let out: string;
let killed: number[];
let clock: number;

const io: Io = {
  stdout: (text) => {
    out += text;
  },
  stderr: (text) => {
    out += text;
  },
};

function deps(overrides: Partial<ControlDeps> = {}): ControlDeps {
  return {
    ...defaultControlDeps(),
    host,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    kill: (pid) => {
      killed.push(pid);
    },
    stopWaitMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'demoflow-files-'));
  // The files below are real: build their paths with this OS's rules.
  host = {
    platform: process.platform,
    env: { XDG_CONFIG_HOME: tmp, APPDATA: tmp },
    homedir: tmp,
  };
  out = '';
  killed = [];
  clock = Date.parse('2026-10-21T12:00:00Z');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runner.lock', () => {
  it.each([
    ['linux', '/home/ada', { XDG_CONFIG_HOME: '/home/ada/.config' }],
    ['darwin', '/Users/ada', {}],
    [
      'win32',
      'C:\\Users\\ada',
      { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
    ],
  ] as const)('lives next to credentials.json on %s', (platform, homedir, env) => {
    const fake: HostEnvironment = { platform, env, homedir };
    const p = pathFor(platform);
    const dir = p.dirname(credentialsPath(fake));
    const paths = runnerPaths(fake);
    expect(paths.dir).toBe(dir);
    for (const [file, name] of [
      [paths.lock, 'runner.lock'],
      [paths.log, 'runner.log'],
      [paths.state, 'runner.state.json'],
      [paths.stop, 'runner.stop'],
      [paths.reportedRuns, 'reported-runs.jsonl'],
    ]) {
      expect(p.dirname(file)).toBe(dir);
      expect(p.basename(file)).toBe(name);
    }
    if (platform === 'win32') {
      expect(paths.lock).toBe(
        'C:\\Users\\ada\\AppData\\Roaming\\demoflow\\runner.lock',
      );
    }
  });

  it('refuses a second holder while the first PID lives', () => {
    const file = runnerPaths(host).lock;
    expect(acquireLock(file, { pid: 100, startedAt: 'a' }, () => true)).toEqual(
      { acquired: true },
    );
    expect(acquireLock(file, { pid: 200, startedAt: 'b' }, () => true)).toEqual(
      { acquired: false, holder: { pid: 100, startedAt: 'a' } },
    );
  });

  it('takes over a lock whose PID is dead, or that is unreadable', () => {
    const file = runnerPaths(host).lock;
    acquireLock(file, { pid: 100, startedAt: 'a' }, () => true);
    expect(
      acquireLock(file, { pid: 200, startedAt: 'b' }, () => false),
    ).toEqual({ acquired: true });
    expect(readLock(file)?.pid).toBe(200);
    writeFileSync(file, 'half');
    expect(acquireLock(file, { pid: 300, startedAt: 'c' }, () => true)).toEqual(
      { acquired: true },
    );
  });

  it('is released only by its holder', () => {
    const file = runnerPaths(host).lock;
    acquireLock(file, { pid: 100, startedAt: 'a' }, () => true);
    releaseLock(file, 200);
    expect(existsSync(file)).toBe(true);
    releaseLock(file, 100);
    expect(existsSync(file)).toBe(false);
  });
});

describe('runner.log', () => {
  it('rotates at the limit and keeps three files in total', () => {
    const file = runnerPaths(host).log;
    const logger = fileLogger(file, { maxBytes: 200 });
    for (let i = 0; i < 40; i++)
      logger.log('info', `line ${i} ${'x'.repeat(30)}`);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const name of [file, `${file}.1`, `${file}.2`]) {
      expect(statSync(name).size).toBeLessThanOrEqual(200);
    }
    expect(readFileSync(file, 'utf8')).toContain('line 39');
  });

  it('redacts anything shaped like a token', () => {
    expect(redact('saw dfr_abc-DEF_123 here')).toBe('saw dfr_*** here');
    const file = runnerPaths(host).log;
    fileLogger(file).log('info', 'token dfr_secret');
    expect(readFileSync(file, 'utf8')).not.toContain('dfr_secret');
  });
});

describe('runner stop', () => {
  const lock = () => runnerPaths(host).lock;

  function holdLock(pid: number) {
    acquireLock(
      lock(),
      { pid, startedAt: new Date(clock).toISOString() },
      () => true,
    );
  }

  function state(pid: number, updatedAt: number) {
    writeState(runnerPaths(host).state, {
      pid,
      startedAt: new Date(clock).toISOString(),
      server: 'https://demoflow.test',
      state: 'connected',
      updatedAt: new Date(updatedAt).toISOString(),
    });
  }

  it('never kills a live PID from a stale lock: a reused PID is left alone', async () => {
    // The lock names this test process: alive, but not a runner.
    holdLock(process.pid);
    expect(await stopRunner(io, deps())).toBe('stale');
    expect(killed).toEqual([]);
    expect(existsSync(lock())).toBe(false);
    expect(out).toContain('left alone');
  });

  it('never kills on a state file that is old or names another PID', async () => {
    holdLock(process.pid);
    state(process.pid, clock - 120_000);
    expect(await stopRunner(io, deps())).toBe('stale');
    holdLock(process.pid);
    state(process.pid + 1, clock);
    expect(await stopRunner(io, deps())).toBe('stale');
    expect(killed).toEqual([]);
  });

  it('kills a daemon that vouched for its PID and did not leave in time', async () => {
    holdLock(4242);
    state(4242, clock);
    expect(await stopRunner(io, deps({ alive: () => true }))).toBe('killed');
    expect(killed).toEqual([4242]);
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(runnerPaths(host).stop)).toBe(false);
  });

  it('asks the daemon through runner.stop and is done when the lock goes', async () => {
    holdLock(4242);
    let polls = 0;
    const result = await stopRunner(
      io,
      deps({
        alive: () => true,
        sleep: async () => {
          polls++;
          if (polls === 1) {
            expect(readFileSync(runnerPaths(host).stop, 'utf8')).toBe('4242\n');
            releaseLock(lock(), 4242);
          }
        },
      }),
    );
    expect(result).toBe('stopped');
    expect(killed).toEqual([]);
  });

  it('reports nothing running and clears a dead lock', async () => {
    holdLock(4242);
    expect(await stopRunner(io, deps({ alive: () => false }))).toBe(
      'not-running',
    );
    expect(existsSync(lock())).toBe(false);
  });
});

describe('runner status', () => {
  it('reports reconnecting with the seconds left', () => {
    acquireLock(
      runnerPaths(host).lock,
      { pid: 4242, startedAt: new Date(clock - 3_725_000).toISOString() },
      () => true,
    );
    writeState(runnerPaths(host).state, {
      pid: 4242,
      startedAt: new Date(clock).toISOString(),
      server: 'https://demoflow.test',
      state: 'reconnecting',
      retryAt: new Date(clock + 7_400).toISOString(),
      updatedAt: new Date(clock).toISOString(),
    });
    expect(runnerStatus(deps({ alive: () => true }))).toMatchObject({
      running: true,
      pid: 4242,
      uptimeSeconds: 3_725,
      connection: 'reconnecting',
      retryInSeconds: 8,
    });
    expect(readState(runnerPaths(host).state)?.state).toBe('reconnecting');
  });

  it('formats uptime', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3_725)).toBe('1h 2m');
    expect(formatDuration(90_000)).toBe('1d 1h');
  });
});

describe('runner logs', () => {
  it('prints the log, and follows it across a rotation', async () => {
    const file = runnerPaths(host).log;
    const logger = fileLogger(file, { maxBytes: 120 });
    logger.log('info', 'first');
    const abort = new AbortController();
    let ticks = 0;
    const done = logsCommand(
      { follow: true },
      io,
      deps({
        sleep: async () => {
          ticks++;
          if (ticks === 1) logger.log('info', 'second');
          if (ticks === 2) logger.log('info', `third ${'x'.repeat(80)}`);
          if (ticks === 3) abort.abort();
        },
      }),
      abort.signal,
    );
    expect(await done).toBe(0);
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('third');
  });

  it('says there is no log yet', async () => {
    expect(await logsCommand({}, io, deps())).toBe(0);
    expect(out).toContain('No runner log yet');
  });
});
