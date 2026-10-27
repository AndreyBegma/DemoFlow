import path from 'node:path';
import { lastDueSlot, type ScheduleConfig } from '@demoflow/core';
import type { RunChild, SpawnRun } from '../../mcp/child.ts';
import type { Clock } from '../connection.ts';
import {
  CHECK_PASS_MAX_MS,
  CHECK_SCENARIO_MAX_MS,
  checkTotals,
  isCheckProgressLine,
} from '../launch/check.ts';
import { LAUNCH_KILL_GRACE_MS } from '../launch/index.ts';
import type { Logger } from '../log.ts';
import {
  type LastPass,
  type PassOutcome,
  readScheduleState,
  type ScheduledRoot,
  type ScheduleState,
  writeScheduleState,
} from './state.ts';

/** Decision 3: the cadence is daily at most; a minute is the precision set. */
export const SCHEDULE_TICK_MS = 60_000;

/** Decision 6: what the website learns of the machine's schedules. */
export type SchedulesSync = {
  type: 'schedules.sync';
  zone: string;
  projects: Array<{ rootPath: string; schedule: ScheduleConfig | null }>;
};

export interface SchedulerDeps {
  clock: Clock;
  logger: Logger;
  /** The machine's IANA zone, asked on every tick: a laptop travels. */
  zone(): string;
  /**
   * Decision 4, read on every tick: the reported registry (the only roots
   * `schedules.sync` names) and the roots `demoflow run` ran in.
   */
  roots(): { reported: Iterable<string>; local: Iterable<string> };
  /** The root's `schedule`, `undefined` without one; throws when the config does not load. */
  loadSchedule(root: string): ScheduleConfig | undefined;
  stateFile: string;
  spawn: SpawnRun;
  /** The daemon's one launch slot; `null` while a website launch holds it. */
  claim(): (() => void) | null;
  /** A `schedules.sync` whose content changed since the last one. */
  onSchedules?: (frame: SchedulesSync) => void;
  /** Decision 5: the daemon runs without an account. */
  local?: boolean;
}

interface Pass {
  root: string;
  child?: RunChild;
  ending?: 'cancelled' | 'timed-out';
  done: Promise<void>;
}

/** A root as `runner.log` names it: its folder name, never its path. */
function label(root: string): string {
  return path.basename(root) || 'root';
}

/**
 * Spec 361, Decision 3: runs a check pass of each watched root at its due
 * slot, one pass at a time and never alongside a website launch. A machine
 * that missed several slots runs one pass (Decision 2).
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private state: ScheduleState = { zone: 'UTC', roots: {} };
  private readonly queue: string[] = [];
  private pass: Pass | null = null;
  private cancelTick: () => void = () => {};
  private stopping: Promise<void> | null = null;
  /** The config failure last logged per root, so each is logged once. */
  private readonly failures = new Map<string, string>();
  private frame: SchedulesSync | null = null;
  private sentFrame = '';

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /** Reads the state file and ticks: on start, then once a minute. */
  start(): void {
    const saved = readScheduleState(this.deps.stateFile);
    if (saved !== null) this.state = saved;
    this.tick();
  }

  /** Called when the launch slot frees up: a queued pass may start. */
  wake(): void {
    this.pump();
  }

  /** The current `schedules.sync`, for the frame after `launches.sync`. */
  schedules(): SchedulesSync | null {
    return this.frame;
  }

  /** Stops ticking and kills a running pass; resolves once it is gone. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.cancelTick();
      this.queue.length = 0;
      const pass = this.pass;
      if (pass === null) return;
      pass.ending ??= 'cancelled';
      await pass.child?.kill();
      await pass.done;
    })();
    return this.stopping;
  }

  private tick(): void {
    if (this.stopping !== null) return;
    const { clock } = this.deps;
    const now = clock.now();
    try {
      this.look(now);
    } catch {
      this.deps.logger.log('error', 'schedule: the tick failed');
    }
    // On the minute, so 09:30 runs at 09:30 and not at 09:30:59.
    const delay = SCHEDULE_TICK_MS - (clock.now() % SCHEDULE_TICK_MS);
    this.cancelTick = clock.after(delay, () => this.tick());
  }

  private look(now: number): void {
    const zone = this.deps.zone();
    const { reported, local } = this.deps.roots();
    const registry = new Set(reported);
    const watched = [...new Set([...registry, ...local])].sort();
    const roots: Record<string, ScheduledRoot> = {};
    for (const root of watched) {
      const previous = this.state.roots[root];
      const schedule = this.scheduleOf(root);
      const entry: ScheduledRoot = {};
      if (previous?.last !== undefined) entry.last = previous.last;
      if (schedule !== undefined) {
        entry.schedule = schedule;
        // A new schedule is not due for a slot before the daemon saw it.
        entry.seenAt = previous?.seenAt ?? new Date(now).toISOString();
      }
      if (entry.schedule !== undefined || entry.last !== undefined) {
        roots[root] = entry;
      }
    }
    const next: ScheduleState = {
      zone,
      ...(this.deps.local === true ? { local: true } : {}),
      roots,
    };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      this.save();
    }
    for (const [root, entry] of Object.entries(roots)) {
      if (this.isDue(root, entry, now, zone)) this.queue.push(root);
    }
    this.sync(
      zone,
      watched.filter((root) => registry.has(root)),
    );
    this.pump();
  }

  private scheduleOf(root: string): ScheduleConfig | undefined {
    try {
      const schedule = this.deps.loadSchedule(root);
      if (this.failures.delete(root)) {
        this.deps.logger.log('info', `schedule: ${label(root)}: config loads`);
      }
      return schedule;
    } catch (error) {
      // Not the message: it may hold a path (spec 248, Decision 13).
      const reason = error instanceof Error ? error.message : String(error);
      if (this.failures.get(root) !== reason) {
        this.failures.set(root, reason);
        this.deps.logger.log(
          'warn',
          `schedule: ${label(root)}: skipped, the config does not load`,
        );
      }
      return undefined;
    }
  }

  private isDue(
    root: string,
    entry: ScheduledRoot,
    now: number,
    zone: string,
  ): boolean {
    if (entry.schedule === undefined) return false;
    if (this.pass?.root === root || this.queue.includes(root)) return false;
    const since = Date.parse(entry.last?.startedAt ?? entry.seenAt ?? '');
    if (Number.isNaN(since)) return false;
    try {
      return lastDueSlot(entry.schedule, now, zone) > since;
    } catch {
      return false;
    }
  }

  private sync(zone: string, reported: string[]): void {
    const frame: SchedulesSync = {
      type: 'schedules.sync',
      zone,
      projects: reported.map((rootPath) => ({
        rootPath,
        schedule: this.state.roots[rootPath]?.schedule ?? null,
      })),
    };
    this.frame = frame;
    const text = JSON.stringify(frame);
    if (text === this.sentFrame) return;
    this.sentFrame = text;
    this.deps.onSchedules?.(frame);
  }

  private save(): void {
    try {
      writeScheduleState(this.deps.stateFile, this.state);
    } catch {
      this.deps.logger.log('warn', 'schedule: could not write the state file');
    }
  }

  /** One pass at a time, in the slot the website's launches use. */
  private pump(): void {
    if (this.pass !== null || this.stopping !== null) return;
    for (;;) {
      const root = this.queue[0];
      if (root === undefined) return;
      const schedule = this.state.roots[root]?.schedule;
      if (schedule === undefined) {
        this.queue.shift();
        continue;
      }
      const release = this.deps.claim();
      if (release === null) return;
      this.queue.shift();
      const pass: Pass = { root, done: Promise.resolve() };
      this.pass = pass;
      pass.done = this.run(pass, schedule)
        .catch(() => {
          this.deps.logger.log(
            'error',
            `schedule: ${label(root)}: pass failed`,
          );
        })
        .finally(() => {
          this.pass = null;
          release();
          this.pump();
        });
      return;
    }
  }

  private async run(pass: Pass, schedule: ScheduleConfig): Promise<void> {
    const { clock, logger } = this.deps;
    const { root } = pass;
    // Decision 3: written before the spawn, so a crash does not repeat the slot.
    const last: LastPass = { startedAt: new Date(clock.now()).toISOString() };
    this.record(root, last);
    // Set from the child's stdout; an object, so the narrowing survives.
    const seen: { totals: { passed: number; failed: number } | null } = {
      totals: null,
    };
    let cancelScenarioCap = (): void => {};
    const capScenario = () => {
      cancelScenarioCap();
      cancelScenarioCap = clock.after(CHECK_SCENARIO_MAX_MS, () => {
        void this.end(pass, 'timed-out');
      });
    };
    const exclude = schedule.exclude ?? [];
    const child = this.deps.spawn(
      [
        'run',
        '--check',
        '--json',
        '--progress',
        '--project',
        root,
        ...exclude.flatMap((id) => ['--exclude', id]),
      ],
      root,
      {
        killGraceMs: LAUNCH_KILL_GRACE_MS,
        onStdoutLine: (line) => {
          if (isCheckProgressLine(line)) capScenario();
          seen.totals = checkTotals(line) ?? seen.totals;
        },
      },
    );
    if (child.pid === undefined) {
      await child.exited;
      logger.log('warn', `schedule: ${label(root)}: the pass did not start`);
      this.finish(root, last, 'not-started', null);
      return;
    }
    pass.child = child;
    logger.log(
      'info',
      `schedule: ${label(root)}: check pass started, ${exclude.length} excluded`,
    );
    capScenario();
    const cancelPassCap = clock.after(CHECK_PASS_MAX_MS, () => {
      void this.end(pass, 'timed-out');
    });
    await child.exited;
    cancelScenarioCap();
    cancelPassCap();
    const outcome: PassOutcome = pass.ending ?? 'finished';
    const counts = outcome === 'finished' ? seen.totals : null;
    logger.log(
      'info',
      `schedule: ${label(root)}: ${outcome}, ${counts?.passed ?? 0} passed, ${counts?.failed ?? 0} failed`,
    );
    this.finish(root, last, outcome, counts);
  }

  private async end(
    pass: Pass,
    reason: 'cancelled' | 'timed-out',
  ): Promise<void> {
    pass.ending ??= reason;
    await pass.child?.kill();
  }

  private finish(
    root: string,
    started: LastPass,
    outcome: PassOutcome,
    counts: { passed: number; failed: number } | null,
  ): void {
    this.record(root, {
      ...started,
      finishedAt: new Date(this.deps.clock.now()).toISOString(),
      outcome,
      ...(counts ?? {}),
    });
  }

  private record(root: string, last: LastPass): void {
    const entry = this.state.roots[root] ?? {};
    this.state = {
      ...this.state,
      roots: { ...this.state.roots, [root]: { ...entry, last } },
    };
    this.save();
  }
}
