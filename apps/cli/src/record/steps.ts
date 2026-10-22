import type {
  Locator,
  ScenarioInput,
  ScenarioStepInput,
  StepInput,
  Viewport,
} from '@demoflow/core';
import { type RecordedData, usedData } from './repeat.ts';

/** A step as the recorder holds it: the step, and why the panel should flag it. */
export interface RecordedStep {
  /** A `repeat` only once the person wrapped a run of steps in one. */
  step: ScenarioStepInput;
  warning?: string;
  /** For a fill: the field it was typed into, as the page identifies it. */
  field?: string;
}

/**
 * Appends a step, folding it into the last one where a person's single
 * gesture arrives as many events: typing into one field is one `fill`, a
 * scroll gesture is one `scroll`, a redirect after a navigation is one
 * `navigate`.
 *
 * Typing into one field keeps the locator of its first event: a later event
 * may resolve the same field to another locator (a slow accessible-name read
 * falls through to the label), and that is still the same gesture.
 */
export function appendStep(
  steps: readonly RecordedStep[],
  next: RecordedStep,
): RecordedStep[] {
  const last = steps.at(-1);
  if (last === undefined || !folds(last, next)) return [...steps, next];
  if (
    last.step.action === 'fill' &&
    next.step.action === 'fill' &&
    sameField(last, next)
  ) {
    return [
      ...steps.slice(0, -1),
      { ...last, step: { ...next.step, target: last.step.target } },
    ];
  }
  return [...steps.slice(0, -1), next];
}

function folds(last: RecordedStep, next: RecordedStep): boolean {
  if (last.step.action !== next.step.action) return false;
  switch (next.step.action) {
    case 'navigate':
    case 'scroll':
      return true;
    case 'fill':
      return (
        last.step.action === 'fill' &&
        (sameField(last, next) ||
          (last.field === undefined &&
            next.field === undefined &&
            sameLocator(last.step.target, next.step.target)))
      );
    default:
      return false;
  }
}

function sameField(a: RecordedStep, b: RecordedStep): boolean {
  return a.field !== undefined && a.field === b.field;
}

export function sameLocator(a: Locator, b: Locator): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A navigation to `url`: a `path` when it stays on the origin of `baseUrl`
 * (the scenario then follows a `--base-url` override), the full `url`
 * otherwise. `null` for anything that is not http(s).
 */
export function navigateStep(url: string, baseUrl: string): StepInput | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (target.origin === new URL(baseUrl).origin) {
    return {
      action: 'navigate',
      path: `${target.pathname}${target.search}${target.hash}`,
    };
  }
  return { action: 'navigate', url: target.href };
}

/** Moves step `index` by `delta` places; out-of-range moves are ignored. */
export function moveStep(
  steps: readonly RecordedStep[],
  index: number,
  delta: number,
): RecordedStep[] {
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) {
    return [...steps];
  }
  const moved = [...steps];
  const [step] = moved.splice(index, 1);
  if (step !== undefined) moved.splice(to, 0, step);
  return moved;
}

export function removeStep(
  steps: readonly RecordedStep[],
  index: number,
): RecordedStep[] {
  return steps.filter((_, i) => i !== index);
}

export function buildScenario(
  name: string,
  viewport: Viewport,
  steps: readonly RecordedStep[],
  data: RecordedData = {},
): ScenarioInput {
  const used = usedData(steps, data);
  return {
    schemaVersion: 1,
    name,
    viewport,
    ...(Object.keys(used).length === 0 ? {} : { data: used }),
    steps: steps.map(({ step }) => step),
  };
}
