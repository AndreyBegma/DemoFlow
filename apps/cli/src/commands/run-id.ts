import { randomBytes } from 'node:crypto';

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
