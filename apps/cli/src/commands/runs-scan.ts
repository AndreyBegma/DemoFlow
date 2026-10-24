import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import {
  type RunResult,
  RunResultSchema,
  type RunStatus,
} from '@demoflow/core';
import { pathFor } from '../config/index.ts';
import { CommandError } from './errors.ts';
import { assertSafeRunId } from './run-id.ts';

/** Spec 283, Decision 5: a run touched this recently may still be running. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** The files that make a directory a run (Decision 3). */
const RESULT_FILE = 'result.json';
const SCENARIO_FILE = 'scenario.json';

export interface RunsStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}

/** What the `runs` commands touch on disk; injected so tests fake errors and OSes (Decision 12). */
export interface RunsFs {
  lstat(file: string): Promise<RunsStat>;
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  realpath(file: string): Promise<string>;
  rm(
    target: string,
    options: { recursive: true; maxRetries: number },
  ): Promise<void>;
}

export const nodeRunsFs: RunsFs = {
  lstat: (file) => lstat(file),
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file, 'utf8'),
  realpath: (file) => realpath(file),
  rm: (target, options) => rm(target, options),
};

/** `settled` and `partial` from the files (Decision 3); `active` overrides both (Decision 5). */
export type RunState = 'settled' | 'partial' | 'active';

export interface LocalRun {
  id: string;
  state: RunState;
  /** From `result.json`, when it parses. */
  status?: RunStatus;
  scenarioName?: string;
  scenarioId?: string;
  startedAt?: string;
  /** The newest modification of the directory or anything under it. */
  modifiedMs: number;
  /** `startedAt` when `result.json` parses, else the directory's mtime (Decision 4). */
  dateMs: number;
  sizeBytes: number;
}

export interface ScanDeps {
  platform: NodeJS.Platform;
  /** Milliseconds since the epoch. */
  now: number;
  fs: RunsFs;
}

/**
 * Every run directly under `runsDir` (Decision 3): a real directory, not a
 * link, with a safe name, holding `result.json` or `scenario.json`. Anything
 * else is invisible. A missing `runsDir` holds no runs.
 */
export async function scanRuns(
  runsDir: string,
  deps: ScanDeps,
): Promise<LocalRun[]> {
  let names: string[];
  try {
    names = await deps.fs.readdir(runsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs: LocalRun[] = [];
  for (const name of names) {
    const run = await readRun(runsDir, name, deps);
    if (run !== null) runs.push(run);
  }
  return runs;
}

async function readRun(
  runsDir: string,
  id: string,
  deps: ScanDeps,
): Promise<LocalRun | null> {
  if (!isSafeRunId(id)) return null;
  const p = pathFor(deps.platform);
  const dir = p.join(runsDir, id);
  let stat: RunsStat;
  let entries: string[];
  try {
    stat = await deps.fs.lstat(dir);
    if (!isRealDirectory(stat)) return null;
    entries = await deps.fs.readdir(dir);
  } catch {
    // Gone or unreadable: not listed, so never deleted.
    return null;
  }
  if (!entries.includes(RESULT_FILE) && !entries.includes(SCENARIO_FILE)) {
    return null;
  }

  const { sizeBytes, newestMs } = await measure(dir, stat, deps);
  const result = await readResult(p.join(dir, RESULT_FILE), deps.fs);
  const run: LocalRun = {
    id,
    state:
      deps.now - newestMs < ACTIVE_WINDOW_MS
        ? 'active'
        : result !== null && result.runId === id && result.status !== 'running'
          ? 'settled'
          : 'partial',
    modifiedMs: newestMs,
    dateMs: stat.mtimeMs,
    sizeBytes,
  };
  if (result !== null) {
    run.status = result.status;
    run.scenarioName = result.scenarioName;
    run.scenarioId = result.scenarioId;
    run.startedAt = result.startedAt;
    run.dateMs = Date.parse(result.startedAt);
  }
  return run;
}

async function readResult(file: string, fs: RunsFs): Promise<RunResult | null> {
  try {
    const parsed = RunResultSchema.safeParse(
      JSON.parse(await fs.readFile(file)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Decision 4: the sum of `lstat` sizes of every file under `dir`, and the
 * newest mtime of `dir` and everything under it. Links are counted, never
 * followed; an entry that vanishes or cannot be read mid-walk is skipped.
 */
async function measure(
  dir: string,
  stat: RunsStat,
  deps: ScanDeps,
): Promise<{ sizeBytes: number; newestMs: number }> {
  const p = pathFor(deps.platform);
  let sizeBytes = 0;
  let newestMs = stat.mtimeMs;
  let names: string[];
  try {
    names = await deps.fs.readdir(dir);
  } catch {
    return { sizeBytes, newestMs };
  }
  for (const name of names) {
    const child = p.join(dir, name);
    let childStat: RunsStat;
    try {
      childStat = await deps.fs.lstat(child);
    } catch {
      continue;
    }
    if (isRealDirectory(childStat)) {
      const inner = await measure(child, childStat, deps);
      sizeBytes += inner.sizeBytes;
      newestMs = Math.max(newestMs, inner.newestMs);
    } else {
      sizeBytes += childStat.size;
      newestMs = Math.max(newestMs, childStat.mtimeMs);
    }
  }
  return { sizeBytes, newestMs };
}

export interface RemoveDeps {
  platform: NodeJS.Platform;
  fs: RunsFs;
}

/**
 * Decision 8: removes `<realRuns>/<id>` and nothing else. The target must sit
 * directly in `realRuns` and still be a real directory just before removal,
 * so a directory swapped for a link since the scan is refused. Node's `rm`
 * removes a link inside the directory as a link, never its target.
 */
export async function removeRun(
  realRuns: string,
  id: string,
  deps: RemoveDeps,
): Promise<void> {
  const p = pathFor(deps.platform);
  const target = p.join(realRuns, id);
  if (p.dirname(target) !== realRuns || p.basename(target) !== id) {
    throw new Error(`${id} does not name a directory in ${realRuns}`);
  }
  const stat = await deps.fs.lstat(target);
  if (!isRealDirectory(stat)) {
    throw new Error(`${target} is no longer a directory`);
  }
  // `maxRetries` rides out Windows EBUSY/EPERM while a video is briefly open.
  await deps.fs.rm(target, { recursive: true, maxRetries: 3 });
}

const DURATION = /^([1-9]\d*)([mhdw])$/;
const UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Decision 7: a positive integer and one of `m`, `h`, `d`, `w`; nothing else. */
export function parseDuration(raw: string): number {
  const match = DURATION.exec(raw);
  const ms =
    match === null ? Number.NaN : Number(match[1]) * UNIT_MS[match[2] ?? ''];
  if (!Number.isSafeInteger(ms)) {
    throw new CommandError(
      'invalid-duration',
      `--older-than must be a positive integer and one of m, h, d, w (90m, 12h, 30d, 2w), got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/** Decision 4: `B`, `KB`, `MB`, `GB` in steps of 1024, one decimal past bytes. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** On a Windows junction `lstat` reports a link, so it is skipped too. */
function isRealDirectory(stat: RunsStat): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function isSafeRunId(id: string): boolean {
  try {
    assertSafeRunId(id);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
