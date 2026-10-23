import type { MarkerKind } from '@demoflow/core';
import type { DemoflowHelpers } from './index.ts';
import { type Recorder, stackHere } from './recorder.ts';

// The `demoflow` test fixture (spec 209, Decision 6): explicit captions and
// scenes, written as `marker` steps in the test process. They never touch
// `window.demoflow`, which exists only while the engine runs the app.

/** Not recording: both do nothing, validate nothing and never throw. */
export const PASS_THROUGH: DemoflowHelpers = {
  caption: () => undefined,
  scene: () => undefined,
};

/** The step `caption` limit, as for page annotations (ADR-0014 §4). */
const CAPTION_MAX = 120;

/** Why `title` (trimmed) cannot be a marker of `kind`, or `undefined`. */
export function markerProblem(
  kind: MarkerKind,
  title: string,
): string | undefined {
  if (kind === 'caption') {
    return title.length === 0 || title.length > CAPTION_MAX
      ? `expected 1–${CAPTION_MAX} characters`
      : undefined;
  }
  return title.length === 0 ? 'expected a title' : undefined;
}

/** Recording: each call appends a marker, in call order. */
export function recordingHelpers(recorder: Recorder): DemoflowHelpers {
  const marker = (kind: MarkerKind, text: unknown): void => {
    const stack = stackHere();
    const title = typeof text === 'string' ? text.trim() : '';
    const problem = markerProblem(kind, title);
    if (problem !== undefined) {
      // Kept on the recorder: a test that catches it still fails.
      throw recorder.keep(
        new Error(`demoflow.${kind}: ${problem} at ${recorder.where(stack)}`),
      );
    }
    recorder.push({ action: 'marker', title, kind });
  };
  return {
    caption: (text) => marker('caption', text),
    scene: (title) => marker('scene', title),
  };
}
