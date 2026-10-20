import type { Navigation, TimelineEvent } from '@demoflow/core';
import type { PlacedCard } from './cards.ts';
import { maskBoxAt } from './frame.ts';
import { shiftPastCards } from './time-map.ts';
import type { MaskSpan, NavigationHold } from './types.ts';

/**
 * The holds of a run's page loads, in page ms (spec 114). Each navigation
 * holds the last source frame before it from its start to its `endMs` — the
 * page's `load` — then dissolves into the ready page over `durationMs`, never
 * past the next navigation or the end of the page. No time is inserted: the
 * hold covers the loading time and the dissolve reveals the ready page.
 *
 * The first navigation leaves about:blank, which is never shown: it holds
 * the background from page 0. A navigation still loading when the recording
 * ended holds until the next step starts, or the page ends (Risks).
 *
 * A hold carries every mask active when its navigation started — or one
 * source frame before, the frame held — at its box then: the held frame
 * shows that page, whatever the live page's masks do meanwhile.
 */
export function planHolds(input: {
  navigations: readonly Navigation[];
  events: readonly TimelineEvent[];
  /** Timeline ms → page ms. */
  out: (timelineMs: number) => number;
  /** Timeline ms → source ms, clamped to the source. */
  toSource: (timelineMs: number) => number;
  /** The first source ms the page shows: after the sync mark, when it was found. */
  sourceStartMs: number;
  pageEndMs: number;
  /** In page ms, before the cards are inserted. */
  masks: readonly MaskSpan[];
  sourceFrameMs: number;
  durationMs: number;
}): NavigationHold[] {
  const { navigations, events, out, pageEndMs } = input;
  const holds: NavigationHold[] = [];
  for (const [index, navigation] of navigations.entries()) {
    const first = index === 0;
    const startMs = first ? 0 : out(navigation.startMs);
    // After a failure the page has ended: this load never showed.
    if (startMs >= pageEndMs) break;
    const readyMs =
      navigation.endMs ??
      events.find((event) => event.startMs > navigation.startMs)?.startMs;
    const endMs = Math.max(
      startMs,
      readyMs === undefined ? pageEndMs : Math.min(out(readyMs), pageEndMs),
    );
    const next = navigations[index + 1];
    const fadeEndMs = Math.max(
      endMs,
      Math.min(
        endMs + input.durationMs,
        next === undefined ? pageEndMs : out(next.startMs),
        pageEndMs,
      ),
    );
    const heldFromMs = startMs - input.sourceFrameMs;
    holds.push({
      startMs,
      endMs,
      fadeEndMs,
      fadeMs: fadeEndMs - endMs,
      ...(first
        ? {}
        : {
            sourceMs: Math.max(
              input.sourceStartMs,
              input.toSource(navigation.startMs) - 1,
            ),
          }),
      masks: first
        ? []
        : input.masks
            .filter(
              (mask) => mask.startMs <= startMs && mask.endMs > heldFromMs,
            )
            .map((mask) =>
              maskBoxAt(
                mask,
                Math.min(Math.max(startMs, mask.startMs), mask.endMs),
              ),
            ),
    });
  }
  return holds;
}

/**
 * Moves holds planned in page ms past the cards (spec 108, Decision 1). A
 * hold across a cut stretches over the card, which draws none of it, so the
 * page frame either side of the card is the held one. The dissolve starts
 * after a card on its cut, and `fadeMs` stays page time.
 */
export function shiftHolds(
  holds: readonly NavigationHold[],
  cards: readonly PlacedCard[],
): NavigationHold[] {
  const at = (ms: number): number => shiftPastCards(cards, ms);
  const until = (ms: number): number =>
    shiftPastCards(cards, ms, { end: true });
  return holds.map((hold) => {
    const startMs = at(hold.startMs);
    const endMs = Math.max(startMs, at(hold.endMs));
    return {
      ...hold,
      startMs,
      endMs,
      fadeEndMs: Math.max(endMs, until(hold.fadeEndMs)),
    };
  });
}
