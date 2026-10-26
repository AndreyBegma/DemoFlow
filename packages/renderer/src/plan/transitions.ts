import type { Navigation, TimelineEvent } from '@demoflow/core';
import type { PlacedCard } from './cards.ts';
import { maskBoxAt } from './frame.ts';
import { shiftPastCards } from './time-map.ts';
import type { Interval, MaskSpan, NavigationHold } from './types.ts';

/**
 * The holds of a run's page loads, in page ms (spec 114). Each navigation
 * holds a frame of the page before it from just before its start to its `endMs` — the
 * page's `load` — then dissolves into the ready page over `durationMs`, never
 * past the next navigation or the end of the page. No time is inserted: the
 * hold covers the loading time and the dissolve reveals the ready page.
 *
 * The first navigation leaves about:blank, which is never shown: it holds
 * the background from page 0. A navigation still loading when the recording
 * ended holds until the next step starts, or the page ends (Risks).
 *
 * The frame held is taken a lead before the navigation's start, not the last
 * one before it: a source frame's time can be early — the recorder snaps
 * frames to its frame rate, and the sync offset has its own error — and the
 * new document's blank page can be painted within that error of the start
 * (#150). An older frame of the same page is invisible; a blank flash is not.
 * For the same reason the hold starts at the frame held, not at the
 * navigation: a live frame in the lead can already read the blank page. It
 * never starts before the previous hold's dissolve ends, nor before the step
 * before the triggering one: at most a lead-long tail of that step's page
 * pixels freezes; the cursor and rings stay live.
 *
 * A hold carries every mask active from the frame held — or one source frame
 * before it — to its navigation's start, at its box on the frame held: that
 * frame shows that page, whatever the live page's masks do meanwhile.
 *
 * A frame held inside a cut (spec 354) never showed: the hold takes the frame
 * a lead before the cut instead.
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
  /** The plan's mask lead: the same sync uncertainty, budgeted for masks. */
  maskLeadMs: number;
  durationMs: number;
  /** The trim and the cuts, timeline ms. */
  removed?: readonly Interval[];
}): NavigationHold[] {
  const { navigations, events, out, pageEndMs } = input;
  const removed = input.removed ?? [];
  const leadMs = Math.max(input.maskLeadMs, 2 * input.sourceFrameMs);
  // Steps that take time: a marker is no action of its own.
  const steps = events.filter((event) => event.endMs > event.startMs);
  const holds: NavigationHold[] = [];
  for (const [index, navigation] of navigations.entries()) {
    const first = index === 0;
    // After a failure the page has ended: this load never showed.
    if (!first && out(navigation.startMs) >= pageEndMs) break;
    // The timeline ms of the frame held, before every cut it falls in.
    let heldMs = navigation.startMs - leadMs;
    let beforeCut = false;
    for (const span of [...removed].reverse()) {
      if (
        Number.isFinite(span.startMs) &&
        span.startMs <= heldMs &&
        heldMs < span.endMs
      ) {
        heldMs = span.startMs - leadMs;
        beforeCut = true;
      }
    }
    // The page ms of the frame held.
    const heldAtMs = out(heldMs);
    const startMs = first
      ? 0
      : Math.max(
          heldAtMs,
          holds.at(-1)?.fadeEndMs ?? 0,
          out(stepBefore(steps, navigation.startMs)?.startMs ?? 0),
        );
    // `showsHeldPage` is this loop's rule for which holds show the old page; keep the two in step.
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
        next === undefined ? pageEndMs : out(next.startMs - leadMs),
        pageEndMs,
      ),
    );
    const navigationMs = out(navigation.startMs);
    holds.push({
      startMs,
      endMs,
      fadeEndMs,
      fadeMs: fadeEndMs - endMs,
      ...(first
        ? {}
        : {
            // From before the navigation even when a clamp starts the hold
            // later than the frame's own time.
            sourceMs: Math.max(
              input.sourceStartMs,
              beforeCut
                ? input.toSource(heldMs)
                : input.toSource(navigation.startMs) - leadMs,
            ),
          }),
      masks: first
        ? []
        : input.masks
            .filter(
              (mask) =>
                mask.startMs <= navigationMs &&
                mask.endMs > heldAtMs - input.sourceFrameMs,
            )
            .map((mask) =>
              maskBoxAt(
                mask,
                Math.min(Math.max(heldAtMs, mask.startMs), mask.endMs),
              ),
            ),
    });
  }
  return holds;
}

/**
 * `holds` with a dissolve at every cut (spec 354, Decision 4), in page ms: at
 * the join the frame held — the last source frame before the cut — dissolves
 * into the page after it over `durationMs`, never past the next hold, the
 * next join or the end of the page. A join inside a page load's hold or
 * dissolve has none: the load already hides it. Like a load's, the hold
 * carries every mask on the frame held, at its box there.
 */
export function withCutHolds(
  holds: readonly NavigationHold[],
  input: {
    /** In page order: the join, the source frame held, and its page ms. */
    joins: readonly { atMs: number; sourceMs: number; heldAtMs: number }[];
    /** In page ms, before the cards are inserted. */
    masks: readonly MaskSpan[];
    pageEndMs: number;
    sourceFrameMs: number;
    durationMs: number;
  },
): NavigationHold[] {
  const { joins, pageEndMs } = input;
  if (joins.length === 0) return [...holds];
  const all = [...holds];
  for (const [index, join] of joins.entries()) {
    const { atMs, heldAtMs } = join;
    if (holds.some((hold) => hold.startMs <= atMs && atMs < hold.fadeEndMs)) {
      continue;
    }
    const fadeEndMs = Math.min(
      atMs + input.durationMs,
      holds.find((hold) => hold.startMs > atMs)?.startMs ?? Infinity,
      joins[index + 1]?.atMs ?? Infinity,
      pageEndMs,
    );
    if (fadeEndMs <= atMs) continue;
    all.push({
      startMs: atMs,
      endMs: atMs,
      fadeEndMs,
      fadeMs: fadeEndMs - atMs,
      sourceMs: join.sourceMs,
      masks: input.masks
        .filter(
          (mask) =>
            mask.startMs <= atMs && mask.endMs > heldAtMs - input.sourceFrameMs,
        )
        .map((mask) =>
          maskBoxAt(
            mask,
            Math.min(Math.max(heldAtMs, mask.startMs), mask.endMs),
          ),
        ),
    });
  }
  return all.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The step before the one a navigation started in: a hold may freeze the
 * tail of it, never more. Not the triggering step itself — a `navigate` step
 * sends its request a few ms after it starts, well inside the error (#150).
 */
function stepBefore(
  steps: readonly TimelineEvent[],
  atMs: number,
): TimelineEvent | undefined {
  const trigger = steps.findLastIndex((step) => step.startMs <= atMs);
  return trigger > 0 ? steps[trigger - 1] : undefined;
}

/**
 * Whether `planHolds` holds the page before navigation `index` on screen, with
 * that page's masks: every navigation but the first (which holds the
 * background), unless the page has ended before it starts.
 */
export function showsHeldPage(
  index: number,
  navigation: Navigation,
  out: (timelineMs: number) => number,
  pageEndMs: number,
): boolean {
  return index > 0 && out(navigation.startMs) < pageEndMs;
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
