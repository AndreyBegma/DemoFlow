import { randomBytes } from 'node:crypto';
import { CommandError } from './errors.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * `YYYYMMDD-HHmmss-<6 lowercase base32 chars>`, UTC (spec 3, Decisions).
 * The clock and the random source are injectable for tests.
 */
export function generateRunId(
  now: Date = new Date(),
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const iso = now.toISOString(); // 2026-10-17T12:34:56.789Z
  const date = iso.slice(0, 10).replaceAll('-', '');
  const time = iso.slice(11, 19).replaceAll(':', '');
  // 256 is a multiple of 32, so `% 32` is uniform.
  const suffix = Array.from(random(6), (byte) => BASE32[byte % 32]).join('');
  return `${date}-${time}-${suffix}`;
}

const SAFE_RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * A caller-chosen run id becomes a directory name: letters, digits, `_`, `.`
 * and `-`, not starting with a dot. No separators, no `.` or `..`, not empty.
 */
export function assertSafeRunId(id: string): void {
  if (!SAFE_RUN_ID.test(id)) {
    throw new CommandError(
      'invalid-run-id',
      `a run id must be a plain directory name (letters, digits, "_", ".", "-"): ${JSON.stringify(id)}`,
    );
  }
}
