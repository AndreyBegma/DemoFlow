import type { Pacing, Step, StepAction } from '@demoflow/core';

/** Steps whose result the viewer sees: the default dwell follows them (C-203). */
export const DWELL_ACTIONS: ReadonlySet<StepAction> = new Set([
  'navigate',
  'click',
  'hover',
  'fill',
  'select',
  'press',
  'scroll',
  'assertVisible',
  'assertText',
]);

/** How one step is paced. */
export interface StepPace {
  /** Slept after the step succeeds, before the next one starts. */
  dwellMs: number;
  /** Between two characters a `fill` types. */
  typingDelayMs: number;
}

export interface PaceMode {
  /** The step is on camera: off-camera steps (setup) are never slowed down. */
  onCamera: boolean;
  /** The run records a video; a check run (ADR-0021) has nothing to watch. */
  recording: boolean;
  /** The last step: the end hold follows it instead of the default dwell. */
  last: boolean;
}

/**
 * The pace of one step (C-203). A step's own `dwellMs` and `typingDelayMs`
 * win over the scenario's pacing; off camera only an explicit typing delay
 * applies, and nothing dwells.
 */
export function stepPace(step: Step, pacing: Pacing, mode: PaceMode): StepPace {
  const ownTyping = step.action === 'fill' ? step.typingDelayMs : undefined;
  const typingDelayMs = ownTyping ?? (mode.onCamera ? pacing.typingDelayMs : 0);
  if (!mode.onCamera || !mode.recording) return { dwellMs: 0, typingDelayMs };
  const dwellMs =
    step.dwellMs ??
    (mode.last || !DWELL_ACTIONS.has(step.action) ? 0 : pacing.stepDwellMs);
  return { dwellMs, typingDelayMs };
}
