const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const STEPS: [
  limitSeconds: number,
  unit: Intl.RelativeTimeFormatUnit,
  size: number,
][] = [
  [3600, 'minute', 60],
  [86400, 'hour', 3600],
  [Number.POSITIVE_INFINITY, 'day', 86400],
];

/**
 * "5 minutes ago" for an ISO time, as seen at `now` (epoch ms). Under a minute
 * returns null so the caller can say "just now".
 */
export function formatRelative(iso: string, now: number): string | null {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return null;
  for (const [limit, unit, size] of STEPS) {
    if (seconds < limit)
      return formatter.format(-Math.floor(seconds / size), unit);
  }
  return null;
}
