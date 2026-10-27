import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { type ScheduleConfig, ScheduleConfigSchema } from '@demoflow/core';

/** How a scheduled check pass ended. */
export type PassOutcome =
  | 'finished'
  | 'timed-out'
  | 'cancelled'
  | 'not-started';

const OUTCOMES: readonly PassOutcome[] = [
  'finished',
  'timed-out',
  'cancelled',
  'not-started',
];

/** The last scheduled pass of a root. Counts only once it finished. */
export interface LastPass {
  startedAt: string;
  finishedAt?: string;
  outcome?: PassOutcome;
  passed?: number;
  failed?: number;
}

/** One root of `schedule.state.json`. */
export interface ScheduledRoot {
  /** The root's parsed `schedule`; absent once its config has none. */
  schedule?: ScheduleConfig;
  /**
   * When the daemon first saw this schedule: a slot before it is not due, so a
   * schedule added today does not fire for yesterday.
   */
  seenAt?: string;
  last?: LastPass;
}

/**
 * `schedule.state.json` (spec 361, Decision 3): written by the daemon only,
 * read by `runner status`. Never a token, never a scenario.
 */
export interface ScheduleState {
  /** The machine's IANA zone when the daemon last looked. */
  zone: string;
  /** `true` while the daemon runs without an account (Decision 5). */
  local?: boolean;
  roots: Record<string, ScheduledRoot>;
}

/** Through a temp file and a rename, so `status` never reads half a file. */
export function writeScheduleState(file: string, state: ScheduleState): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A missing or malformed file is `null`; a malformed root is left out. */
export function readScheduleState(file: string): ScheduleState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.zone !== 'string' || !isRecord(raw.roots)) {
    return null;
  }
  const roots: Record<string, ScheduledRoot> = {};
  for (const [root, value] of Object.entries(raw.roots)) {
    if (!isRecord(value)) continue;
    const entry: ScheduledRoot = {};
    const schedule = ScheduleConfigSchema.safeParse(value.schedule);
    if (schedule.success) entry.schedule = schedule.data;
    if (typeof value.seenAt === 'string') entry.seenAt = value.seenAt;
    const last = lastPassOf(value.last);
    if (last !== undefined) entry.last = last;
    roots[root] = entry;
  }
  return {
    zone: raw.zone,
    ...(raw.local === true ? { local: true } : {}),
    roots,
  };
}

function lastPassOf(value: unknown): LastPass | undefined {
  if (!isRecord(value) || typeof value.startedAt !== 'string') return undefined;
  const last: LastPass = { startedAt: value.startedAt };
  if (typeof value.finishedAt === 'string') last.finishedAt = value.finishedAt;
  const outcome = OUTCOMES.find((known) => known === value.outcome);
  if (outcome !== undefined) last.outcome = outcome;
  if (isCount(value.passed)) last.passed = value.passed;
  if (isCount(value.failed)) last.failed = value.failed;
  return last;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
