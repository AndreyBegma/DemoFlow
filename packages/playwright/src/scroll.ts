import type { Page } from '@playwright/test';
import type { Recorder } from './recorder.ts';
import { type ScrollPosition, scrollStep } from './steps.ts';

// A page scroll is recorded from its effect, not from the code that caused it
// (ADR-0015 §5): `page.evaluate` and `page.mouse.wheel` read the page's
// scroll position before and after.

/** The page's scroll position now. */
function readScroll(page: Page): Promise<ScrollPosition> {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    maxY: document.documentElement.scrollHeight - window.innerHeight,
  }));
}

/**
 * The page's scroll position once it stops moving: unchanged for two
 * animation frames, or after 1,000 ms. A wheel scroll is not finished when
 * `mouse.wheel` resolves.
 */
function settledScroll(page: Page): Promise<ScrollPosition> {
  return page.evaluate(async () => {
    const read = () => ({
      x: window.scrollX,
      y: window.scrollY,
      maxY: document.documentElement.scrollHeight - window.innerHeight,
    });
    const start = performance.now();
    let last = read();
    let still = 0;
    while (still < 2 && performance.now() - start < 1_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = read();
      if (now.x === last.x && now.y === last.y) {
        still += 1;
      } else {
        still = 0;
        last = now;
      }
    }
    return last;
  });
}

/** Runs a call and records the page scroll it caused, from its effect. */
export async function scrolling(
  recorder: Recorder,
  call: string,
  stack: string,
  run: () => unknown,
): Promise<unknown> {
  const before = await readScroll(recorder.page).catch(() => undefined);
  const result = await run();
  const after = await settledScroll(recorder.page).catch(() => undefined);
  if (before === undefined || after === undefined) {
    recorder.omit(call, stack, 'the page navigated or closed; no scroll read');
    return result;
  }
  const mapped = scrollStep(before, after);
  if (mapped === undefined) {
    recorder.omit(call, stack, 'it did not move the page');
  } else if ('step' in mapped) {
    recorder.push(mapped.step);
  } else {
    recorder.omit(call, stack, mapped.reason);
  }
  return result;
}
