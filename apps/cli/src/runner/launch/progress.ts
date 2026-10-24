import type { Progress } from '../../commands/progress.ts';
import type { Clock } from '../connection.ts';

/** Decision 5: the most steps a progress line may claim. */
const MAX_STEPS = 10_000;
/** Decision 6: at most one `run.progress` frame per this long. */
export const PROGRESS_INTERVAL_MS = 1_000;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Decision 5: a progress line of the child, or `null` for anything else — the
 * `--json` result, garbage, a shape out of range. Never throws.
 */
export function parseProgressLine(line: string): Progress | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { type, phase, step, steps } = value as Record<string, unknown>;
  if (type !== 'progress') return null;
  if (phase === 'app' || phase === 'rendering') {
    return step === undefined && steps === undefined ? { phase } : null;
  }
  if (
    phase === 'steps' &&
    isCount(step) &&
    isCount(steps) &&
    step >= 1 &&
    step <= steps &&
    steps <= MAX_STEPS
  ) {
    return { phase, step, steps };
  }
  return null;
}

function same(a: Progress, b: Progress): boolean {
  if (a.phase !== b.phase) return false;
  return (
    a.phase !== 'steps' ||
    (b.phase === 'steps' && a.step === b.step && a.steps === b.steps)
  );
}

/**
 * Decision 6: sends a progress only when it changed and at most once per
 * `PROGRESS_INTERVAL_MS`; while the second is not up the latest one waits.
 */
export class ProgressGate {
  private readonly send: (progress: Progress) => void;
  private readonly clock: Clock;
  private last: Progress | null = null;
  private lastAt = 0;
  private waiting: Progress | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;

  constructor(clock: Clock, send: (progress: Progress) => void) {
    this.clock = clock;
    this.send = send;
  }

  push(progress: Progress): void {
    if (this.stopped) return;
    if (this.last !== null && same(progress, this.last)) {
      // Back to what the page already shows: whatever waits is stale.
      this.waiting = null;
      return;
    }
    const wait =
      this.last === null
        ? 0
        : this.lastAt + PROGRESS_INTERVAL_MS - this.clock.now();
    if (wait <= 0) {
      this.emit(progress);
      return;
    }
    this.waiting = progress;
    this.cancelTimer ??= this.clock.after(wait, () => {
      this.cancelTimer = null;
      const next = this.waiting;
      this.waiting = null;
      if (next !== null && !this.stopped) this.emit(next);
    });
  }

  /** Drops what waits; nothing is sent after it. */
  stop(): void {
    this.stopped = true;
    this.waiting = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private emit(progress: Progress): void {
    this.last = progress;
    this.lastAt = this.clock.now();
    this.send(progress);
  }
}
