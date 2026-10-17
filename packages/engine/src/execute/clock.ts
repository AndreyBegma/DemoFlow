import { performance } from 'node:perf_hooks';

/** Milliseconds since the page was created — the video's first frame (spec 3, Decisions). */
export interface Clock {
  now(): number;
}

export function startClock(): Clock {
  const zero = performance.now();
  return { now: () => Math.max(0, performance.now() - zero) };
}
