import type {
  Box,
  MaskedElement,
  MaskInterval,
  Navigation,
  TimelineEvent,
} from '@demoflow/core';
import { showsHeldPage } from './transitions.ts';
import type { MaskSpan } from './types.ts';

/** Masks overhang the field's box by this much on every side. */
const MASK_MARGIN_PX = 4;

/**
 * A blurred box over every masked field while it is on the page.
 *
 * A masked event that carries `maskVisibility` gets one span per interval: from
 * the interval's start (less the lead) to its end (plus the trail), or to the
 * video's end when the interval is open. Intervals may overlap for one step (a navigation that
 * leaves the field on screen); both boxes are masked then. Page scrolls that
 * start inside an interval move its box; the span does not end when the box
 * leaves the viewport, since the field is still on the page and may scroll back.
 *
 * A timeline from before `maskVisibility` has no intervals, so the old rule
 * stays: the mask runs from the event's start until a `navigate` ends, a page
 * scroll takes the box fully out of the viewport, or the video ends.
 *
 * Either way, a document navigation (`timeline.navigations`, #114) then ends
 * the span when the old document leaves the screen, never earlier (spec 146):
 * see `documentEndMs`. An interval that overlaps a sibling (a navigation that
 * left the field on screen, #18) keeps its span as measured.
 *
 * A masked event with no box (its field could not be measured, #42) masks the
 * whole viewport from its start to the end of the video.
 *
 * An element the application marked `data-demoflow-mask` (#197) gets one span
 * per interval of `maskedElements`, timed the same way, with one static box:
 * the engine measured it in viewport space on every frame, and a move starts
 * a new interval, so a page scroll does not move it. A document navigation
 * may lengthen its span, never shorten it (#221).
 */
export function maskSpans(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  videoEndMs: number,
  {
    leadMs,
    trailMs,
    maskedElements,
    ...leaving
  }: {
    leadMs: number;
    trailMs: number;
    maskedElements: readonly MaskedElement[];
    navigations: readonly Navigation[];
    transitions: boolean;
    sourceFrameMs: number;
  },
): MaskSpan[] {
  const documentEnd = (fromMs: number, endMs: number): number =>
    documentEndMs(fromMs, endMs, { ...leaving, out, trailMs, videoEndMs });
  const spans: MaskSpan[] = [];
  for (const [index, event] of events.entries()) {
    if (event.masked !== true) continue;
    if (event.maskVisibility !== undefined) {
      for (const interval of event.maskVisibility) {
        const startMs = Math.max(0, out(interval.startMs) - leadMs);
        const endMs =
          interval.endMs === undefined
            ? videoEndMs
            : Math.min(out(interval.endMs) + trailMs, videoEndMs);
        let box = grow(interval.box, MASK_MARGIN_PX);
        const keys: MaskSpan['keys'] = [{ atMs: startMs, box }];
        for (const later of events.slice(index + 1)) {
          const scroll = later.scroll;
          if (scroll === undefined || scroll.container !== undefined) continue;
          if (
            later.startMs < interval.startMs ||
            (interval.endMs !== undefined && later.startMs >= interval.endMs)
          ) {
            continue;
          }
          keys.push({ atMs: Math.min(out(later.startMs), endMs), box });
          box = {
            ...box,
            x: box.x - (scroll.after.x - scroll.before.x),
            y: box.y - (scroll.after.y - scroll.before.y),
          };
          keys.push({ atMs: Math.min(out(later.endMs), endMs), box });
        }
        // The keys stay as measured: a hold reads the box at its start from them.
        spans.push({
          startMs,
          endMs: overlapsSibling(interval, event.maskVisibility)
            ? endMs
            : documentEnd(interval.startMs, endMs),
          keys,
        });
      }
      continue;
    }
    if (event.target === undefined) {
      // #42: a field that could not be measured; the whole viewport, to the end.
      spans.push(wholeViewport(event, out, viewport, videoEndMs, leadMs));
      continue;
    }
    let box = grow(event.target.box, MASK_MARGIN_PX);
    const startMs = Math.max(0, out(event.startMs) - leadMs);
    const keys: MaskSpan['keys'] = [{ atMs: startMs, box }];
    let endMs = videoEndMs;
    for (const later of events.slice(index + 1)) {
      if (later.action === 'navigate') {
        endMs = out(later.endMs) + trailMs;
        break;
      }
      const scroll = later.scroll;
      // A container scroll moves what is inside it; the masked field is not assumed to be.
      if (scroll === undefined || scroll.container !== undefined) continue;
      keys.push({ atMs: out(later.startMs), box });
      box = {
        ...box,
        x: box.x - (scroll.after.x - scroll.before.x),
        y: box.y - (scroll.after.y - scroll.before.y),
      };
      keys.push({ atMs: out(later.endMs), box });
      if (!overlaps(box, viewport)) {
        endMs = out(later.endMs) + trailMs;
        break;
      }
    }
    spans.push({
      startMs,
      endMs: documentEnd(event.startMs, Math.min(endMs, videoEndMs)),
      keys,
    });
  }
  for (const element of maskedElements) {
    for (const interval of element.intervals) {
      const startMs = Math.max(0, out(interval.startMs) - leadMs);
      const endMs =
        interval.endMs === undefined
          ? videoEndMs
          : Math.min(out(interval.endMs) + trailMs, videoEndMs);
      spans.push({
        startMs,
        // A move overlaps the next box by one frame: both are masked as measured.
        // A navigation only lengthens the span (#221): the engine ends an interval its
        // document left itself, and a start that errs early can precede the very load that
        // brought the element in, which would read as the one that took it away.
        endMs: overlapsSibling(interval, element.intervals)
          ? endMs
          : Math.max(endMs, documentEnd(interval.startMs, endMs)),
        keys: [{ atMs: startMs, box: grow(interval.box, MASK_MARGIN_PX) }],
      });
    }
  }
  return spans;
}

/**
 * When the document a mask's field was measured on leaves the screen (spec
 * 146), given the span's start in timeline ms and its end in page ms. The
 * first document navigation that starts after it governs, when the span is
 * still up on the frame before it starts (the frame a hold shows):
 *
 * - transitions on, and `planHolds` holds the old page for it
 *   (`showsHeldPage`): its start. The hold draws its own masks from there.
 * - otherwise (transitions off, the first navigation, a load past the page's
 *   end): its `endMs` plus the trail, since the old page stays on screen until
 *   the new one loads. This may lengthen the span as well as shorten it.
 * - a navigation still open at the end of the recording: the span as given.
 *
 * With no navigations (a timeline from before #114) the span is as given.
 */
function documentEndMs(
  fromMs: number,
  endMs: number,
  {
    navigations,
    transitions,
    sourceFrameMs,
    out,
    trailMs,
    videoEndMs,
  }: {
    navigations: readonly Navigation[];
    transitions: boolean;
    sourceFrameMs: number;
    out: (timelineMs: number) => number;
    trailMs: number;
    videoEndMs: number;
  },
): number {
  // Strictly after: a load that starts with the field's measure brings that document in.
  const index = navigations.findIndex(
    (navigation) => navigation.startMs > fromMs,
  );
  const navigation = navigations[index];
  if (navigation === undefined) return endMs;
  const leavesMs = out(navigation.startMs);
  // Gone before the navigation: the frame it starts on never showed it.
  if (endMs <= leavesMs - sourceFrameMs) return endMs;
  if (transitions && showsHeldPage(index, navigation, out, videoEndMs)) {
    return Math.min(endMs, leavesMs);
  }
  if (navigation.endMs === undefined) return endMs;
  return Math.min(out(navigation.endMs) + trailMs, videoEndMs);
}

/** Whether `interval` shares any time with another interval of the same field or element. */
function overlapsSibling(
  interval: MaskInterval,
  intervals: readonly MaskInterval[],
): boolean {
  const end = interval.endMs ?? Infinity;
  return intervals.some(
    (other) =>
      other !== interval &&
      other.startMs < end &&
      interval.startMs < (other.endMs ?? Infinity),
  );
}

function wholeViewport(
  event: TimelineEvent,
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  videoEndMs: number,
  leadMs: number,
): MaskSpan {
  const startMs = Math.max(0, out(event.startMs) - leadMs);
  const box = grow(
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    MASK_MARGIN_PX,
  );
  return { startMs, endMs: videoEndMs, keys: [{ atMs: startMs, box }] };
}

function grow(box: Box, by: number): Box {
  return {
    x: box.x - by,
    y: box.y - by,
    width: box.width + 2 * by,
    height: box.height + 2 * by,
  };
}

function overlaps(
  box: Box,
  viewport: { width: number; height: number },
): boolean {
  return (
    box.x < viewport.width &&
    box.y < viewport.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
}
