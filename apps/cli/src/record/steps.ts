import type {
  Locator,
  ScenarioInput,
  StepInput,
  Viewport,
} from '@demoflow/core';

/** A step as the recorder holds it: the step, and why the panel should flag it. */
export interface RecordedStep {
  step: StepInput;
  warning?: string;
}

/**
 * Appends a step, folding it into the last one where a person's single
 * gesture arrives as many events: typing into one field is one `fill`, a
 * scroll gesture is one `scroll`, a redirect after a navigation is one
 * `navigate`.
 */
export function appendStep(
  steps: readonly RecordedStep[],
  next: RecordedStep,
): RecordedStep[] {
  const last = steps.at(-1);
  if (last !== undefined && folds(last.step, next.step)) {
    return [...steps.slice(0, -1), next];
  }
  return [...steps, next];
}

function folds(last: StepInput, next: StepInput): boolean {
  if (last.action !== next.action) return false;
  switch (next.action) {
    case 'navigate':
    case 'scroll':
      return true;
    case 'fill':
      return last.action === 'fill' && sameLocator(last.target, next.target);
    default:
      return false;
  }
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
): ScenarioInput {
  return {
    schemaVersion: 1,
    name,
    viewport,
    steps: steps.map(({ step }) => step),
  };
}
