import type { Page } from 'playwright';
import type { Clock } from './clock.ts';

/** Saturated, so VP8 compression cannot hide it and no page content resembles it (#19). */
export const SYNC_MARK_COLOUR = '#ff00ff';

/**
 * The mark is repainted every frame for this long, a level off its colour
 * every other frame. Playwright's screencast sends a frame only when the page
 * produces one, and it may start after the mark is painted: a mark that
 * produced no further frame was missing from 6 runs in 20 (#48).
 */
export const SYNC_MARK_REPAINT_MS = 200;

/**
 * How long the mark is up in all, on the page's frame clock. The last 200 ms
 * are still: a clear straight after the repaints shows up ~60 ms late in the
 * video, a clear after a still stretch does not (#48, measured).
 */
export const SYNC_MARK_HOLD_MS = 400;

/** Clock exchanges made to map page time to engine time; the fastest one is kept. */
export const SYNC_EXCHANGES = 5;

export interface SyncMark {
  colour: string;
  onMs: number;
  offMs: number;
}

/** One page-clock reading, bracketed by engine-clock readings around its round-trip. */
export interface ClockExchange {
  sentMs: number;
  pageMs: number;
  receivedMs: number;
}

const ELEMENT_ID = '__demoflow_sync_mark__';

/** The colour every other repainted frame shows: one level off, within the renderer's tolerance. */
const REPAINT_COLOUR = '#fe00fe';

/**
 * Paints a full-frame colour on the blank page, holds it, and clears it. The
 * renderer finds the clear in the video and measures the video/clock offset
 * from `offMs` (#19).
 *
 * Both edges are frame timestamps taken in the page — the frame that first
 * shows the mark and the frame that first lacks it — and mapped onto the
 * engine clock afterwards (#48), so no round-trip lands in them.
 *
 * Never throws: a run is not failed over the mark, it just goes without one.
 */
export async function recordSyncMark(
  page: Page,
  clock: Clock,
): Promise<SyncMark | undefined> {
  try {
    const edges = await page.evaluate(showMark, {
      id: ELEMENT_ID,
      colour: SYNC_MARK_COLOUR,
      repaintColour: REPAINT_COLOUR,
      repaintMs: SYNC_MARK_REPAINT_MS,
      holdMs: SYNC_MARK_HOLD_MS,
    });
    const exchanges: ClockExchange[] = [];
    for (let i = 0; i < SYNC_EXCHANGES; i++) {
      const sentMs = clock.now();
      const pageMs = await page.evaluate(() => performance.now());
      exchanges.push({ sentMs, pageMs, receivedMs: clock.now() });
    }
    return toSyncMark(edges, exchanges);
  } catch {
    return undefined;
  }
}

/**
 * The page's edges on the engine clock, or `undefined` when they make no sense.
 *
 * A frame's timestamp is when the frame began, which on a busy page can be
 * before the script that painted the mark ran — so `onMs` can map to a hair
 * before clock zero (−0.3 ms, measured under a loaded test run, #48). The
 * timeline refuses a negative `onMs`, so it is raised to zero — and `offMs`
 * moves up by the same amount, so the hold the page measured between the two
 * frames (`holdMs` or more) survives the clamp (#64: clamping `onMs` alone
 * recorded 394.74 ms of a 400 ms hold). `offMs` moves later only by the
 * mapping error of the exchange, never earlier.
 */
export function toSyncMark(
  edges: { onMs: number; offMs: number },
  exchanges: readonly ClockExchange[],
): SyncMark | undefined {
  if (!(edges.offMs > edges.onMs)) return undefined;
  const shiftMs = pageToClockShift(exchanges);
  const mappedOnMs = edges.onMs + shiftMs;
  if (mappedOnMs >= 0) {
    return {
      colour: SYNC_MARK_COLOUR,
      onMs: mappedOnMs,
      offMs: edges.offMs + shiftMs,
    };
  }
  return {
    colour: SYNC_MARK_COLOUR,
    onMs: 0,
    offMs: edges.offMs - edges.onMs,
  };
}

/**
 * What to add to a page time to get the engine time, NTP-style: the page read
 * its clock at the midpoint of the round-trip, give or take half of it, so the
 * exchange with the shortest round-trip is the tightest bound.
 */
export function pageToClockShift(exchanges: readonly ClockExchange[]): number {
  let best: ClockExchange | undefined;
  for (const exchange of exchanges) {
    const roundTrip = exchange.receivedMs - exchange.sentMs;
    if (best === undefined || roundTrip < best.receivedMs - best.sentMs) {
      best = exchange;
    }
  }
  if (best === undefined) throw new Error('no clock exchange');
  return (best.sentMs + best.receivedMs) / 2 - best.pageMs;
}

/**
 * Runs in the page: paints the mark, repaints it every frame for `repaintMs`,
 * holds it still until `holdMs`, clears it, and resolves once a frame without
 * it was produced. `onMs` is the timestamp of the first frame drawn with the
 * mark, `offMs` of the first frame drawn without it — the clear happens in
 * that frame's callback, before it paints.
 */
function showMark(input: {
  id: string;
  colour: string;
  repaintColour: string;
  repaintMs: number;
  holdMs: number;
}): Promise<{ onMs: number; offMs: number }> {
  const mark = document.createElement('div');
  mark.id = input.id;
  mark.setAttribute(
    'style',
    `position:fixed;inset:0;z-index:2147483647;background:${input.colour}`,
  );
  document.documentElement.appendChild(mark);
  return new Promise((resolve) => {
    let onMs: number | undefined;
    let odd = false;
    const frame = (atMs: number): void => {
      if (onMs === undefined) onMs = atMs;
      if (atMs - onMs < input.holdMs) {
        odd = atMs - onMs < input.repaintMs && !odd;
        mark.style.background = odd ? input.repaintColour : input.colour;
        requestAnimationFrame(frame);
        return;
      }
      mark.remove();
      const shownMs = onMs;
      requestAnimationFrame(() => resolve({ onMs: shownMs, offMs: atMs }));
    };
    requestAnimationFrame(frame);
  });
}
