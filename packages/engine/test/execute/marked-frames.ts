import type { Box } from '@demoflow/core';
import type { Page } from 'playwright';
import { expect } from 'vitest';
import type { EngineObserver } from '../../src/index.ts';

/** The page global (a registered symbol) the probe records on. */
const FRAMES_KEY = 'demoflow.test.markedFrames';

/** Where each document writes the last frame that showed the element, read after it has gone (#197). */
const LAST_SHOWN_KEY = 'demoflow.test.lastShown';

/** Clock exchanges per read, as the engine's sync mark takes (#19). */
const EXCHANGES = 5;

/** One drawn frame, in page time: its `requestAnimationFrame` timestamp and the marked element's box, if it was on screen. */
export type MarkedFrame = readonly [atMs: number, box: Box | null];

export interface MarkedRead {
  frames: MarkedFrame[];
  /** The test process's clock minus the page's, bounded by the exchanges' round trips. */
  shift: { minMs: number; maxMs: number };
  /** The last frame any document of the tab drew the element in, in that document's time. */
  lastShownMs: number | null;
}

/**
 * Records, frame by frame, the box of the element with `id` while it carries
 * `data-demoflow-mask` and is on screen — by the mask's rule, in the same
 * `requestAnimationFrame` frames the engine samples — and reads them when
 * each step finishes, with a clock exchange, as `pageFrames` does (#173).
 */
export function markedFrames(id: string): {
  observer: EngineObserver;
  reads: Map<number, MarkedRead>;
  /** The test process's clock at engine zero, at the latest. */
  zeroMs(): number;
} {
  const reads = new Map<number, MarkedRead>();
  let zeroMs = Number.POSITIVE_INFINITY;
  let page: Page | undefined;
  return {
    reads,
    zeroMs: () => zeroMs,
    observer: {
      onPageCreated: async (event) => {
        zeroMs = performance.now();
        page = event.page;
        await page.addInitScript(probe, {
          key: FRAMES_KEY,
          lastKey: LAST_SHOWN_KEY,
          id,
        });
      },
      onStepStarted: ({ startMs }) => {
        zeroMs = Math.min(zeroMs, performance.now() - startMs);
      },
      onStepFinished: async ({ stepIndex }) => {
        if (page === undefined) return;
        try {
          const { frames, lastShownMs } = await page.evaluate(settledFrames, {
            key: FRAMES_KEY,
            lastKey: LAST_SHOWN_KEY,
          });
          let minMs = Number.NEGATIVE_INFINITY;
          let maxMs = Number.POSITIVE_INFINITY;
          for (let i = 0; i < EXCHANGES; i++) {
            const sentMs = performance.now();
            const pageMs = await page.evaluate(() => window.performance.now());
            const receivedMs = performance.now();
            minMs = Math.max(minMs, sentMs - pageMs);
            maxMs = Math.min(maxMs, receivedMs - pageMs);
          }
          reads.set(stepIndex, {
            frames,
            shift: { minMs, maxMs },
            lastShownMs,
          });
        } catch {
          // A page between documents has nothing to read; a test that needs this step fails on the missing read.
        }
      },
    },
  };
}

/** An engine time in the page time of `read`'s document, and the exchange's uncertainty — the only tolerance. */
export function inPage(
  engineMs: number,
  read: MarkedRead,
  zeroMs: number,
): { atMs: number; uncertaintyMs: number } {
  return {
    atMs: engineMs + zeroMs - read.shift.maxMs,
    uncertaintyMs: read.shift.maxMs - read.shift.minMs,
  };
}

/** A start no later than the frame at `frameMs`: the first that drew the element. */
export function expectStartBy(
  startMs: number,
  frameMs: number,
  read: MarkedRead,
  zeroMs: number,
): void {
  const { atMs, uncertaintyMs } = inPage(startMs, read, zeroMs);
  expect(atMs).toBeLessThanOrEqual(frameMs + uncertaintyMs);
}

/** An end no earlier than the frame at `frameMs`: the last that drew the element. */
export function expectEndAfter(
  endMs: number | undefined,
  frameMs: number,
  read: MarkedRead,
  zeroMs: number,
): void {
  expect(endMs).toBeDefined();
  if (endMs === undefined) return;
  const { atMs, uncertaintyMs } = inPage(endMs, read, zeroMs);
  expect(atMs).toBeGreaterThanOrEqual(frameMs - uncertaintyMs);
}

/** Runs in every document, before its scripts: one frame loop, for the document's life. */
function probe(input: { key: string; lastKey: string; id: string }): void {
  const frames: Array<[number, Box | null]> = [];
  Object.defineProperty(window, Symbol.for(input.key), { value: frames });
  const boxOf = (): Box | null => {
    const element = document.getElementById(input.id);
    if (element === null || !element.hasAttribute('data-demoflow-mask')) {
      return null;
    }
    if (!element.checkVisibility()) return null;
    if (getComputedStyle(element).visibility !== 'visible') return null;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const frame = (atMs: number): void => {
    const box = boxOf();
    frames.push([atMs, box]);
    if (box !== null) {
      try {
        sessionStorage.setItem(input.lastKey, String(atMs));
      } catch {
        // An opaque origin has no storage; a test that needs it fails on the missing value.
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Runs in the page: the frames so far, once two more are drawn, and the last frame any document showed the element. */
async function settledFrames(input: {
  key: string;
  lastKey: string;
}): Promise<{ frames: MarkedFrame[]; lastShownMs: number | null }> {
  const slot = window as unknown as Record<symbol, MarkedFrame[] | undefined>;
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  let lastShownMs: number | null = null;
  try {
    const value = sessionStorage.getItem(input.lastKey);
    lastShownMs = value === null ? null : Number(value);
  } catch {
    lastShownMs = null;
  }
  return { frames: [...(slot[Symbol.for(input.key)] ?? [])], lastShownMs };
}
