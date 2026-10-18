import type { Page } from 'playwright';
import type { Clock } from './clock.ts';

/** Saturated, so VP8 compression cannot hide it and no page content resembles it (#19). */
export const SYNC_MARK_COLOUR = '#ff00ff';

/** Three frames at Playwright's 25 fps is 120 ms; the margin absorbs timer slop. */
export const SYNC_MARK_HOLD_MS = 140;

export interface SyncMark {
  colour: string;
  onMs: number;
  offMs: number;
}

const ELEMENT_ID = '__demoflow_sync_mark__';

/**
 * Paints a full-frame colour on the blank page, holds it, and clears it. The
 * renderer finds the clear in the video and measures the video/clock offset
 * from `offMs` (#19). Times are taken after a frame has been presented, as
 * close to the paint and the clear as the page lets us get.
 *
 * Never throws: a run is not failed over the mark, it just goes without one.
 */
export async function recordSyncMark(
  page: Page,
  clock: Clock,
): Promise<SyncMark | undefined> {
  try {
    await page.evaluate(paint, { id: ELEMENT_ID, colour: SYNC_MARK_COLOUR });
    const onMs = clock.now();

    while (clock.now() - onMs < SYNC_MARK_HOLD_MS) {
      await page.waitForTimeout(5);
    }

    await page.evaluate(clear, ELEMENT_ID);
    const offMs = clock.now();
    return offMs > onMs ? { colour: SYNC_MARK_COLOUR, onMs, offMs } : undefined;
  } catch {
    return undefined;
  }
}

// Runs in the page: paints, then resolves once a frame carrying it was produced.
function paint(input: { id: string; colour: string }): Promise<void> {
  const mark = document.createElement('div');
  mark.id = input.id;
  mark.setAttribute(
    'style',
    `position:fixed;inset:0;z-index:2147483647;background:${input.colour}`,
  );
  document.documentElement.appendChild(mark);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// Runs in the page: clears, then resolves once a frame without it was produced.
function clear(id: string): Promise<void> {
  document.getElementById(id)?.remove();
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
