import { performance } from 'node:perf_hooks';
import type { EngineObserver } from '../../src/index.ts';

/**
 * Records when each step's `mouse.up` resolved, on the engine clock: the
 * clock is read off `onStepStarted`, which is emitted right after the step's
 * `startMs` is taken. For tests that pin a mask edge to a click's input (#155).
 */
export function mouseUps(): {
  observer: EngineObserver;
  /** Step index → when its last mouse up resolved. */
  times: Map<number, number>;
} {
  const times = new Map<number, number>();
  let step = -1;
  let zeroMs = 0;
  return {
    times,
    observer: {
      onPageCreated: ({ page }) => {
        const up = page.mouse.up.bind(page.mouse);
        page.mouse.up = async (options) => {
          await up(options);
          times.set(step, performance.now() - zeroMs);
        };
      },
      onStepStarted: ({ stepIndex, startMs }) => {
        step = stepIndex;
        zeroMs = performance.now() - startMs;
      },
    },
  };
}
