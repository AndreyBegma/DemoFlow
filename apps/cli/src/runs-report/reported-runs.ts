import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Spec 192, Decision 2: past 1 MiB, the index keeps its last 2,000 lines. */
export const INDEX_MAX_BYTES = 1024 * 1024;
export const INDEX_KEEP_LINES = 2_000;

/** One line of `reported-runs.jsonl`: a server run id and where it lives here. */
export interface ReportedRun {
  id: string;
  runDir: string;
  at: string;
  /** Spec 225: the server's project id; absent on older lines. */
  projectId?: string;
  /** Spec 225: the server origin at report time; absent on older lines. */
  server?: string;
}

/** Spec 225, Decision 2: the run's page on the website, when the entry has what it takes. */
export function runPageUrl(entry: ReportedRun): string | undefined {
  if (entry.server === undefined || entry.projectId === undefined) {
    return undefined;
  }
  return `${entry.server}/app/projects/${encodeURIComponent(entry.projectId)}/runs/${encodeURIComponent(entry.id)}`;
}

/**
 * Spec 225, Decision 3: one read of the index, keyed by `path.resolve(runDir)`;
 * the last line for a directory wins. Never throws: a missing or unreadable
 * file gives an empty map, and malformed lines are skipped.
 */
export async function readReportedRunsByDir(
  file: string,
): Promise<Map<string, ReportedRun>> {
  const byDir = new Map<string, ReportedRun>();
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      const entry = parseLine(line);
      if (entry !== null) byDir.set(path.resolve(entry.runDir), entry);
    }
  } catch {
    // An unreadable index is an empty one.
  }
  return byDir;
}

/** The page URL of a run directory, from a map read once. */
export function pageUrlFor(
  index: ReadonlyMap<string, ReportedRun>,
  runDir: string,
): string | undefined {
  const entry = index.get(path.resolve(runDir));
  return entry === undefined ? undefined : runPageUrl(entry);
}

/**
 * Decision 1: one `appendFileSync` of one short line, so two runs finishing
 * together never interleave or lose each other's entry.
 */
export function appendReportedRun(file: string, entry: ReportedRun): void {
  mkdirSync(path.dirname(file), { recursive: true });
  prune(file);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** A lost race here costs one entry, which then plays as `not-found`. */
function prune(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= INDEX_MAX_BYTES) return;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${lines.slice(-INDEX_KEEP_LINES).join('\n')}\n`, {
    mode: 0o600,
  });
  renameSync(temp, file);
}

/**
 * Decision 3: the last valid line with this id wins; malformed lines are
 * skipped. Read on every lookup, so a new run plays without a restart.
 */
export async function findReportedRun(
  file: string,
  id: string,
): Promise<ReportedRun | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let found: ReportedRun | null = null;
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (entry?.id === id) found = entry;
  }
  return found;
}

function parseLine(line: string): ReportedRun | null {
  if (line.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { id, runDir, at, projectId, server } = value as Record<
    string,
    unknown
  >;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof runDir !== 'string' || runDir === '') return null;
  const entry: ReportedRun = {
    id,
    runDir,
    at: typeof at === 'string' ? at : '',
  };
  if (typeof projectId === 'string' && projectId !== '') {
    entry.projectId = projectId;
  }
  if (typeof server === 'string' && server !== '') entry.server = server;
  return entry;
}
