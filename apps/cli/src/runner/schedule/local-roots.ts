import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Spec 361, Decision 4: the file keeps the last 500 roots. */
export const LOCAL_ROOTS_KEEP = 500;

/**
 * The roots of `local-roots.jsonl`, oldest first, once each. Never throws: a
 * missing or unreadable file holds none, and malformed lines are skipped.
 */
export function readLocalRoots(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return parseRoots(text);
}

function parseRoots(text: string): string[] {
  const roots = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const root =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).root
        : undefined;
    if (typeof root !== 'string' || root === '') continue;
    // The last line for a root is where it sits now.
    roots.delete(root);
    roots.add(root);
  }
  return [...roots];
}

/**
 * Spec 361, Decision 4: `demoflow run` records its canonical root, so the
 * daemon watches a project's schedule without an account. A root already
 * listed is not appended again; past 500 roots the oldest go. Never throws:
 * a run's outcome does not depend on this file.
 */
export function recordLocalRoot(file: string, root: string): void {
  try {
    const roots = readLocalRoots(file);
    if (roots.includes(root)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    if (roots.length < LOCAL_ROOTS_KEEP) {
      // One append of one short line: two runs together never interleave.
      appendFileSync(file, `${JSON.stringify({ root })}\n`, { mode: 0o600 });
      return;
    }
    const kept = [...roots.slice(-(LOCAL_ROOTS_KEEP - 1)), root];
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      kept.map((entry) => `${JSON.stringify({ root: entry })}\n`).join(''),
      { mode: 0o600 },
    );
    renameSync(temp, file);
  } catch {
    // A root not recorded is a schedule that waits for the next run.
  }
}
