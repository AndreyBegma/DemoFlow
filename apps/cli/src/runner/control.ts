import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { nextDueSlot, type ScheduleConfig } from '@demoflow/core';
import { readCredentials } from '../auth/credentials.ts';
import type { Io } from '../commands/io.ts';
import { currentHost, type HostEnvironment } from '../config/platform.ts';
import { CLI_ENTRY } from '../entry.ts';
import type { Autostart } from './autostart.ts';
import { platformAutostart } from './install/autostart.ts';
import { isAlive, type LockHolder, readLock, releaseLock } from './lock.ts';
import { redact } from './log.ts';
import { type RunnerPaths, runnerPaths } from './paths.ts';
import { hasScheduledRoot } from './schedule/roots.ts';
import { type LastPass, readScheduleState } from './schedule/state.ts';
import { type ConnectionState, type RunnerState, readState } from './state.ts';

/** `start` waits this long for the child to take the lock. */
export const START_WAIT_MS = 5_000;
/** `stop` waits this long for the daemon to leave on its own. */
export const STOP_WAIT_MS = 10_000;
/** A state file older than this does not vouch for its PID (Decision 1, stop). */
export const STATE_FRESH_MS = 90_000;
const POLL_MS = 100;
const LOG_TAIL_LINES = 20;

/** Everything `runner start | stop | status | logs` touch outside the process. */
export interface ControlDeps {
  host: HostEnvironment;
  /** The command that runs the daemon: `node <cli> runner --foreground`. */
  daemon: { command: string; args: string[] };
  now(): number;
  sleep(ms: number): Promise<void>;
  alive(pid: number): boolean;
  /** A hard kill, used only on a daemon that vouched for its PID. */
  kill(pid: number): void;
  autostart: Autostart;
  startWaitMs: number;
  stopWaitMs: number;
}

export const defaultControlDeps = (): ControlDeps => ({
  host: currentHost(),
  daemon: {
    command: process.execPath,
    args: [CLI_ENTRY, 'runner', '--foreground'],
  },
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
  alive: isAlive,
  kill: hardKill,
  autostart: platformAutostart(),
  startWaitMs: START_WAIT_MS,
  stopWaitMs: STOP_WAIT_MS,
});

/** `demoflow runner start`: spawns the daemon detached, its output into the log. */
export async function startRunner(io: Io, deps: ControlDeps): Promise<number> {
  const paths = runnerPaths(deps.host);
  // Spec 361, Decision 5: a scheduled root runs without an account.
  if (
    readCredentials(deps.host) === null &&
    !hasScheduledRoot(paths, deps.host.env)
  ) {
    io.stderr('Not logged in; run demoflow login first\n');
    return 1;
  }
  const running = runningHolder(paths, deps);
  if (running !== null) {
    io.stdout(`Runner already running (PID ${running.pid})\n`);
    return 0;
  }

  mkdirSync(paths.dir, { recursive: true });
  const out = openSync(paths.log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(deps.daemon.command, deps.daemon.args, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: deps.host.env,
    });
  } finally {
    closeSync(out);
  }
  const seen: { exited: number | null; error: Error | null } = {
    exited: null,
    error: null,
  };
  child.once('exit', (code) => {
    seen.exited = code ?? 1;
  });
  child.once('error', (error) => {
    seen.error = error;
  });
  child.unref();

  const deadline = deps.now() + deps.startWaitMs;
  while (deps.now() < deadline) {
    const holder = readLock(paths.lock);
    if (holder !== null && holder.pid === child.pid) {
      io.stdout(`Runner started (PID ${holder.pid})\n`);
      return 0;
    }
    if (seen.error !== null) {
      io.stderr(`Cannot start the runner: ${seen.error.message}\n`);
      return 1;
    }
    if (seen.exited !== null) {
      // Another `start` may have won the race; that one is running.
      if (seen.exited === 0 && holder !== null && deps.alive(holder.pid)) {
        io.stdout(`Runner already running (PID ${holder.pid})\n`);
        return 0;
      }
      break;
    }
    await deps.sleep(POLL_MS);
  }
  io.stderr(
    `The runner did not start. The end of ${paths.log}:\n${logTail(paths.log)}`,
  );
  return 1;
}

export type StopResult = 'not-running' | 'stopped' | 'killed' | 'stale';

/**
 * `demoflow runner stop`: asks the daemon to leave through `runner.stop`, the
 * same on every OS. A daemon that does not leave in time is killed only when
 * its fresh state file names the same PID: a stale lock whose PID was reused
 * by another program is removed, and that program is never touched.
 */
export async function stopRunner(
  io: Io,
  deps: ControlDeps,
  options: { quiet?: boolean } = {},
): Promise<StopResult> {
  const paths = runnerPaths(deps.host);
  const holder = readLock(paths.lock);
  if (holder === null || !deps.alive(holder.pid)) {
    if (holder !== null) releaseLock(paths.lock, holder.pid);
    if (options.quiet !== true) io.stdout('Runner is not running\n');
    return 'not-running';
  }
  writeFileSync(paths.stop, `${holder.pid}\n`);
  try {
    const deadline = deps.now() + deps.stopWaitMs;
    while (deps.now() < deadline) {
      if (readLock(paths.lock)?.pid !== holder.pid || !deps.alive(holder.pid)) {
        io.stdout(`Runner stopped (PID ${holder.pid})\n`);
        return 'stopped';
      }
      await deps.sleep(POLL_MS);
    }
    const state = readState(paths.state);
    releaseLock(paths.lock, holder.pid);
    if (state !== null && vouches(state, holder, deps.now())) {
      deps.kill(holder.pid);
      io.stdout(
        `Runner (PID ${holder.pid}) did not stop in ${Math.round(deps.stopWaitMs / 1000)} s; killed it\n`,
      );
      return 'killed';
    }
    io.stdout(
      `PID ${holder.pid} did not answer and may not be the runner, so it was left alone; removed the stale lock\n`,
    );
    return 'stale';
  } finally {
    rmSync(paths.stop, { force: true });
  }
}

/** What `runner status` reports. Never the token. */
export interface RunnerStatus {
  running: boolean;
  pid: number | null;
  uptimeSeconds: number | null;
  connection: ConnectionState | 'not connected';
  retryInSeconds: number | null;
  server: string | null;
  autostart: boolean;
  /** Spec 361: each scheduled project, as the daemon last saw it. */
  schedules: ScheduledProject[];
}

export interface ScheduledProject {
  rootPath: string;
  schedule: ScheduleConfig;
  /** The machine's zone the times are in. */
  zone: string;
  /** `null` while the runner is not running: nothing will run it. */
  nextCheckAt: string | null;
  lastCheck: LastPass | null;
}

export function runnerStatus(deps: ControlDeps): RunnerStatus {
  const paths = runnerPaths(deps.host);
  const holder = runningHolder(paths, deps);
  const state = readState(paths.state);
  const credentials = readCredentials(deps.host);
  const own = holder !== null && state !== null && state.pid === holder.pid;
  let connection: RunnerStatus['connection'] = 'not connected';
  let retryInSeconds: number | null = null;
  if (own) {
    connection = state.state;
    if (state.state === 'reconnecting' && state.retryAt !== undefined) {
      retryInSeconds = Math.max(
        0,
        Math.ceil((Date.parse(state.retryAt) - deps.now()) / 1000),
      );
    }
  } else if (holder === null && state?.state === 'revoked') {
    connection = 'revoked';
  } else if (holder !== null) {
    connection = 'connecting';
  }
  const started = holder === null ? Number.NaN : Date.parse(holder.startedAt);
  return {
    running: holder !== null,
    pid: holder?.pid ?? null,
    uptimeSeconds: Number.isNaN(started)
      ? null
      : Math.max(0, Math.floor((deps.now() - started) / 1000)),
    connection,
    retryInSeconds,
    server: credentials?.server ?? (own ? (state.server ?? null) : null),
    autostart: deps.autostart.installed(deps.host),
    schedules: scheduledProjects(paths, holder !== null, deps.now()),
  };
}

/** From `schedule.state.json`: the daemon's view, no config is read here. */
function scheduledProjects(
  paths: RunnerPaths,
  running: boolean,
  now: number,
): ScheduledProject[] {
  const saved = readScheduleState(paths.scheduleState);
  if (saved === null) return [];
  const projects: ScheduledProject[] = [];
  for (const [rootPath, entry] of Object.entries(saved.roots)) {
    if (entry.schedule === undefined) continue;
    let next: number | null = null;
    try {
      next = running ? nextDueSlot(entry.schedule, now, saved.zone) : null;
    } catch {
      // A zone this Node does not know: no time to show.
    }
    projects.push({
      rootPath,
      schedule: entry.schedule,
      zone: saved.zone,
      nextCheckAt: next === null ? null : new Date(next).toISOString(),
      lastCheck: entry.last ?? null,
    });
  }
  return projects;
}

/** `demoflow runner status [--json]`. */
export function statusCommand(
  flags: { json?: boolean },
  io: Io,
  deps: ControlDeps,
): number {
  const status = runnerStatus(deps);
  if (flags.json === true) {
    io.stdout(`${redact(JSON.stringify(status))}\n`);
    return 0;
  }
  const lines = [
    `Runner:     ${status.running ? `running (PID ${status.pid}${status.uptimeSeconds === null ? '' : `, up ${formatDuration(status.uptimeSeconds)}`})` : 'not running'}`,
    `Connection: ${connectionText(status)}`,
    `Server:     ${status.server ?? 'not logged in'}`,
    `Autostart:  ${status.autostart ? 'installed' : 'not installed'}`,
  ];
  for (const project of status.schedules) {
    lines.push(
      `Schedule:   ${project.rootPath} (${scheduleText(project.schedule)})`,
      `  next check: ${project.nextCheckAt === null ? 'when the runner is running' : localTime(project.nextCheckAt, project.zone)}`,
      `  last check: ${lastCheckText(project.lastCheck, project.zone)}`,
    );
  }
  io.stdout(`${redact(lines.join('\n'))}\n`);
  return 0;
}

function connectionText(status: RunnerStatus): string {
  if (status.connection === 'local') return 'local mode: scheduled checks only';
  if (status.connection === 'reconnecting' && status.retryInSeconds !== null) {
    return `reconnecting in ${status.retryInSeconds}s`;
  }
  return status.connection;
}

function scheduleText(schedule: ScheduleConfig): string {
  const when =
    schedule.cadence === 'weekly'
      ? `weekly on ${schedule.weekday ?? '?'}`
      : schedule.cadence;
  const excluded = schedule.exclude?.length ?? 0;
  return `${when} at ${schedule.at}${excluded === 0 ? '' : `, ${excluded} excluded`}`;
}

function lastCheckText(last: LastPass | null, zone: string): string {
  if (last === null) return 'none yet';
  const at = localTime(last.startedAt, zone);
  if (last.outcome === undefined) return `${at}, no result yet`;
  if (last.outcome !== 'finished') return `${at}, ${last.outcome}`;
  return `${at}, ${last.passed ?? 0} passed, ${last.failed ?? 0} failed`;
}

/** `YYYY-MM-DD HH:MM` in the daemon's zone; the ISO time when the zone is unknown. */
function localTime(iso: string, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(iso));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  } catch {
    return iso;
  }
}

/** `demoflow runner logs [--follow]`: the current `runner.log`, then what is appended. */
export async function logsCommand(
  flags: { follow?: boolean },
  io: Io,
  deps: ControlDeps,
  signal?: AbortSignal,
): Promise<number> {
  const file = runnerPaths(deps.host).log;
  if (!existsSync(file) && flags.follow !== true) {
    io.stderr(`No runner log yet (${file})\n`);
    return 0;
  }
  // `ino` as a bigint: on Windows it is the 64-bit NTFS file ID, and as a
  // `number` it loses its low bits past 2^53, so a file and its successor can
  // compare equal and a rotation goes unseen.
  let followed: { ino: bigint; offset: number } | null = null;
  const drain = () => {
    let current: { ino: bigint; size: number };
    try {
      const stats = statSync(file, { bigint: true });
      current = { ino: stats.ino, size: Number(stats.size) };
    } catch {
      return;
    }
    if (
      followed !== null &&
      (followed.ino !== current.ino || current.size < followed.offset)
    ) {
      // Rotated: finish the file we were reading, now `.1`, then start over.
      try {
        const previous = statSync(`${file}.1`, { bigint: true });
        if (previous.ino === followed.ino) {
          io.stdout(
            readFrom(`${file}.1`, followed.offset, Number(previous.size)),
          );
        }
      } catch {
        // Rotated twice since the last look: those lines are in `.2`.
      }
      followed = null;
    }
    const offset = followed?.offset ?? 0;
    io.stdout(readFrom(file, offset, current.size));
    followed = { ino: current.ino, offset: Math.max(offset, current.size) };
  };
  drain();
  if (flags.follow !== true) return 0;
  while (signal?.aborted !== true) {
    await deps.sleep(500);
    drain();
  }
  return 0;
}

/** Bytes `from`..`to` of a file, as text; empty when there are none. */
function readFrom(file: string, from: number, to: number): string {
  if (to <= from) return '';
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(to - from);
    let read = 0;
    while (read < chunk.length) {
      const n = readSync(fd, chunk, read, chunk.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return chunk.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The lock's holder while its PID is alive; a stale lock is `null`. */
function runningHolder(
  paths: RunnerPaths,
  deps: ControlDeps,
): LockHolder | null {
  const holder = readLock(paths.lock);
  return holder !== null && deps.alive(holder.pid) ? holder : null;
}

function vouches(state: RunnerState, holder: LockHolder, now: number): boolean {
  const updated = Date.parse(state.updatedAt);
  return (
    state.pid === holder.pid &&
    !Number.isNaN(updated) &&
    now - updated < STATE_FRESH_MS
  );
}

function hardKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone in the meantime.
  }
}

function logTail(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '(no log)\n';
  }
  const lines = text.trimEnd().split(/\r?\n/).slice(-LOG_TAIL_LINES);
  return `${redact(lines.join('\n'))}\n`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
