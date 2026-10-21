import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Who holds `runner.lock`. */
export interface LockHolder {
  pid: number;
  startedAt: string;
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; holder: LockHolder };

/** Whether a PID names a live process; `EPERM` is a live process of another user. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A missing or unreadable lock is `null`. */
export function readLock(file: string): LockHolder | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { pid, startedAt } = raw as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return { pid, startedAt: typeof startedAt === 'string' ? startedAt : '' };
}

/**
 * Takes the one-daemon-per-machine lock. The file is written whole under a
 * temporary name and hard-linked into place, so the link either fails with
 * `EEXIST` or publishes a complete file: a reader never sees half a lock. A
 * lock whose PID is dead, or unreadable, is stale and taken over once.
 */
export function acquireLock(
  file: string,
  holder: LockHolder,
  alive: (pid: number) => boolean = isAlive,
): LockResult {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${holder.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(holder)}\n`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temp, file);
        return { acquired: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = readLock(file);
      if (current !== null && current.pid === holder.pid) {
        return { acquired: true };
      }
      if (current !== null && alive(current.pid)) {
        return { acquired: false, holder: current };
      }
      rmSync(file, { force: true });
    }
    const current = readLock(file);
    if (current === null) throw new Error(`cannot take the lock ${file}`);
    return { acquired: false, holder: current };
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Removes the lock only while `pid` holds it. */
export function releaseLock(file: string, pid: number): void {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}
