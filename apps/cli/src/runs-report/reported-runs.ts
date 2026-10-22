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
  const { id, runDir, at } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof runDir !== 'string' || runDir === '') return null;
  return { id, runDir, at: typeof at === 'string' ? at : '' };
}
