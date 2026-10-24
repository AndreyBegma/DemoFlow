import { expandScenario } from '@demoflow/core';
import type { EngineObserver } from '@demoflow/engine';
import type { Io } from './io.ts';

/** A run longer than this in steps reports no step progress (spec 302). */
export const MAX_PROGRESS_STEPS = 10_000;

/** One line of `demoflow run --progress`: what the run is doing now. */
export type Progress =
  | { phase: 'app' }
  | { phase: 'steps'; step: number; steps: number }
  | { phase: 'rendering' };

/** The line as printed on stdout, newline included. */
export function formatProgress(progress: Progress): string {
  return `${JSON.stringify({ type: 'progress', ...progress })}\n`;
}

/**
 * Writes a progress line. A progress write can never fail the run: a stdout
 * that went away (the daemon died) is not a reason to stop.
 */
export function emitProgress(io: Io, progress: Progress): void {
  try {
    io.stdout(formatProgress(progress));
  } catch {
    // Progress is best effort.
  }
}

/** Prints `step n of m` as each expanded step starts; never throws. */
export function progressObserver(io: Io): EngineObserver {
  let total = 0;
  return {
    onRunStarted: (event) => {
      try {
        total = expandScenario(event.scenario).steps.length;
      } catch {
        total = 0;
      }
    },
    onStepStarted: (event) => {
      if (total < 1 || total > MAX_PROGRESS_STEPS) return;
      emitProgress(io, {
        phase: 'steps',
        step: event.stepIndex + 1,
        steps: total,
      });
    },
  };
}
