import { performance } from 'node:perf_hooks';
import type { TimelineEvent } from '@demoflow/core';
import type { Page } from 'playwright';
import { expect } from 'vitest';
import type { EngineObserver } from '../../src/index.ts';

/** The page global (a registered symbol) the probe records on. */
const FRAMES_KEY = 'demoflow.test.frames';

/** Clock exchanges per read, as the engine's sync mark takes (#19). */
const EXCHANGES = 5;

/** One drawn frame, in page time: its `requestAnimationFrame` timestamp and whether the field was on screen. */
export type PageFrame = readonly [atMs: number, shown: boolean];

export interface FramesRead {
  frames: PageFrame[];
  /** The test process's clock minus the page's, bounded by the exchanges' round trips. */
  shift: { minMs: number; maxMs: number };
}

/**
 * Records, frame by frame, whether the element with `id` is on screen — by
 * the mask watch's rule, in the same `requestAnimationFrame` frames — and
 * reads them when each step finishes, with a clock exchange to map the
 * engine's times into page time. For tests that pin a mask edge to the frame
 * the page drew it in (#173), not to a wall-clock margin.
 */
export function pageFrames(id: string): {
  observer: EngineObserver;
  /** Step index → the frames drawn up to its end, and the clock shift then. */
  reads: Map<number, FramesRead>;
  /**
   * The test process's clock at engine zero, at the latest. Each estimate is
   * taken after the engine read its clock, so the smallest is the tightest.
   */
  zeroMs(): number;
} {
  const reads = new Map<number, FramesRead>();
  let zeroMs = Number.POSITIVE_INFINITY;
  let page: Page | undefined;
  return {
    reads,
    zeroMs: () => zeroMs,
    observer: {
      onPageCreated: async (event) => {
        // The engine's clock starts before the page is announced.
        zeroMs = performance.now();
        page = event.page;
        await page.addInitScript(probe, { key: FRAMES_KEY, id });
      },
      onStepStarted: ({ startMs }) => {
        zeroMs = Math.min(zeroMs, performance.now() - startMs);
      },
      onStepFinished: async ({ stepIndex }) => {
        if (page === undefined) return;
        try {
          const frames = await page.evaluate(settledFrames, FRAMES_KEY);
          reads.set(stepIndex, { frames, shift: await clockShift(page) });
        } catch {
          // A page between documents has nothing to read; a test that needs this step fails on the missing read.
        }
      },
    },
  };
}

/** The test process's clock minus the page's, bounded by `EXCHANGES` round trips. */
export async function clockShift(
  page: Page,
): Promise<{ minMs: number; maxMs: number }> {
  let minMs = Number.NEGATIVE_INFINITY;
  let maxMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < EXCHANGES; i++) {
    const sentMs = performance.now();
    // `window.`: this file's `performance` is Node's, which the page does not have.
    const pageMs = await page.evaluate(() => window.performance.now());
    const receivedMs = performance.now();
    minMs = Math.max(minMs, sentMs - pageMs);
    maxMs = Math.min(maxMs, receivedMs - pageMs);
  }
  return { minMs, maxMs };
}

/**
 * An end the page saw (#155), by the page's own frames (#173): mapped into
 * page time, not before the first frame drawn without the field, and before
 * the frame after it — each widened by the clock exchange's uncertainty, the
 * only tolerance. A wall-clock margin after the click does not hold on a
 * runner that skips frames for 100 ms. Also before the click step's own end,
 * and never before the click began.
 */
export function expectPreciseEnd(
  endMs: number | undefined,
  click: TimelineEvent,
  frames: ReturnType<typeof pageFrames>,
): void {
  expect(endMs).toBeDefined();
  expect(endMs).toBeLessThan(click.endMs);
  expect(endMs).toBeGreaterThan(click.startMs);
  const read = frames.reads.get(click.stepIndex);
  expect(read).toBeDefined();
  if (endMs === undefined || read === undefined) return;
  // The last time the field left the screen by the click step's end.
  const drawn = read.frames;
  const hidden = drawn.findLastIndex(
    ([, shown], i) => !shown && i > 0 && drawn[i - 1][1],
  );
  expect(hidden).toBeGreaterThan(0);
  expect(hidden).toBeLessThan(drawn.length - 1);
  const { minMs, maxMs } = read.shift;
  const uncertaintyMs = maxMs - minMs;
  const pageEndMs = endMs + frames.zeroMs() - maxMs;
  expect(pageEndMs).toBeGreaterThanOrEqual(drawn[hidden][0] - uncertaintyMs);
  expect(pageEndMs).toBeLessThan(drawn[hidden + 1][0] + uncertaintyMs);
}

/** Runs in every document, before its scripts: one frame loop, for the document's life. */
function probe(input: { key: string; id: string }): void {
  const frames: Array<[number, boolean]> = [];
  Object.defineProperty(window, Symbol.for(input.key), { value: frames });
  const shown = (): boolean => {
    const element = document.getElementById(input.id);
    if (element === null || !element.checkVisibility()) return false;
    if (getComputedStyle(element).visibility !== 'visible') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const frame = (atMs: number): void => {
    frames.push([atMs, shown()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Runs in the page: the frames so far, once two more are drawn — so a frame after the last change exists. */
async function settledFrames(key: string): Promise<PageFrame[]> {
  const slot = window as unknown as Record<symbol, PageFrame[] | undefined>;
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return [...(slot[Symbol.for(key)] ?? [])];
}
