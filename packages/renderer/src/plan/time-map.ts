import type { Interval, TimeSegment } from './types.ts';

/**
 * Idle stretches (spec 4, Decisions; ADR-0004 §5): the parts of the frozen
 * stretches that no active event overlaps, at least `thresholdMs` long, inside
 * `[0, endMs]`. A frame that moves is never frozen, so a spinner is never idle.
 */
export function idleStretches(
  freezes: readonly Interval[],
  active: readonly Interval[],
  thresholdMs: number,
  endMs: number,
): Interval[] {
  const idle: Interval[] = [];
  for (const freeze of freezes) {
    let pieces: Interval[] = [
      {
        startMs: Math.max(0, freeze.startMs),
        endMs: Math.min(endMs, freeze.endMs),
      },
    ];
    for (const window of active) {
      pieces = pieces.flatMap((piece) => subtract(piece, window));
    }
    idle.push(
      ...pieces.filter((piece) => piece.endMs - piece.startMs >= thresholdMs),
    );
  }
  return mergeSorted(idle);
}

/** `intervals` less every one of `removed`. */
export function subtractIntervals(
  intervals: readonly Interval[],
  removed: readonly Interval[],
): Interval[] {
  let pieces = intervals.map((interval) => ({ ...interval }));
  for (const window of removed) {
    pieces = pieces.flatMap((piece) => subtract(piece, window));
  }
  return pieces;
}

function subtract(piece: Interval, cut: Interval): Interval[] {
  if (cut.endMs <= piece.startMs || cut.startMs >= piece.endMs) return [piece];
  const out: Interval[] = [];
  if (cut.startMs > piece.startMs) {
    out.push({ startMs: piece.startMs, endMs: cut.startMs });
  }
  if (cut.endMs < piece.endMs) {
    out.push({ startMs: cut.endMs, endMs: piece.endMs });
  }
  return out;
}

function mergeSorted(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      out.push({ ...interval });
    }
  }
  return out;
}

/**
 * The time map: source `[startMs, endMs]` in order, real time except the idle
 * stretches, which each play in `compressToMs`, and the cuts (spec 354,
 * Decision 2), which play in 0 ms: a segment with a source span and no
 * output, so every instant inside a cut maps to the join. A cut is taken out
 * of the idle stretches first; what is left of a stretch still plays in
 * `compressToMs`. Output 0 is source `startMs`.
 */
export function buildTimeMap(
  idle: readonly Interval[],
  endMs: number,
  compressToMs: number,
  startMs = 0,
  cuts: readonly Interval[] = [],
): TimeSegment[] {
  const segments: TimeSegment[] = [];
  let source = startMs;
  let output = 0;
  const push = (sourceEndMs: number, outputLength: number): void => {
    if (sourceEndMs <= source) return;
    segments.push({
      outputStartMs: output,
      outputEndMs: output + outputLength,
      sourceStartMs: source,
      sourceEndMs,
    });
    source = sourceEndMs;
    output += outputLength;
  };
  const stretches = [
    ...subtractIntervals(idle, cuts).map((piece) => ({ ...piece, cut: false })),
    ...cuts.map((cut) => ({ ...cut, cut: true })),
  ].sort((a, b) => a.startMs - b.startMs);
  for (const stretch of stretches) {
    if (stretch.startMs >= endMs) break;
    const stretchStart = Math.max(stretch.startMs, source);
    push(stretchStart, stretchStart - source);
    const stretchEnd = Math.min(stretch.endMs, endMs);
    push(
      stretchEnd,
      stretch.cut ? 0 : Math.min(compressToMs, stretchEnd - stretchStart),
    );
  }
  push(endMs, endMs - source);
  return segments;
}

/** A card at page time `atMs`: output time of the map without cards. */
export interface CardSlot {
  atMs: number;
  durationMs: number;
}

/**
 * Inserts each card into `map`, a map without cards (spec 108, Decision 1):
 * the page is cut at the card's `atMs`, the card plays for its duration on
 * the frame there — a segment with no source span — and the page resumes on
 * the same frame. `cards` are in page order; one past the end goes after it.
 */
export function insertCards(
  map: readonly TimeSegment[],
  cards: readonly CardSlot[],
): TimeSegment[] {
  const out: TimeSegment[] = [];
  let shift = 0;
  let next = 0;
  const card = (atMs: number, sourceMs: number): void => {
    const { durationMs } = cards[next++];
    out.push({
      outputStartMs: atMs + shift,
      outputEndMs: atMs + shift + durationMs,
      sourceStartMs: sourceMs,
      sourceEndMs: sourceMs,
    });
    shift += durationMs;
  };
  for (const segment of map) {
    let piece = segment;
    while (next < cards.length && cards[next].atMs < piece.outputEndMs) {
      const atMs = Math.max(cards[next].atMs, piece.outputStartMs);
      if (atMs > piece.outputStartMs) {
        const sourceMs = lerp(
          atMs,
          piece.outputStartMs,
          piece.outputEndMs,
          piece.sourceStartMs,
          piece.sourceEndMs,
        );
        out.push({
          outputStartMs: piece.outputStartMs + shift,
          outputEndMs: atMs + shift,
          sourceStartMs: piece.sourceStartMs,
          sourceEndMs: sourceMs,
        });
        piece = { ...piece, outputStartMs: atMs, sourceStartMs: sourceMs };
      }
      card(atMs, piece.sourceStartMs);
    }
    out.push({
      ...piece,
      outputStartMs: piece.outputStartMs + shift,
      outputEndMs: piece.outputEndMs + shift,
    });
  }
  const last = map.at(-1);
  while (next < cards.length) {
    card(last?.outputEndMs ?? 0, last?.sourceEndMs ?? 0);
  }
  return out;
}

/**
 * Page ms → output ms once `cards` are inserted: later by every card before
 * it. An instant on a card's cut lands just after the card; the `end` of a
 * half-open span there lands just before it, since the span is already over.
 */
export function shiftPastCards(
  cards: readonly CardSlot[],
  pageMs: number,
  { end = false }: { end?: boolean } = {},
): number {
  let shifted = pageMs;
  for (const card of cards) {
    if (end ? card.atMs < pageMs : card.atMs <= pageMs) {
      shifted += card.durationMs;
    }
  }
  return shifted;
}

/** Source ms → output ms, clamped to the map; a cut with a card on it maps past the card. */
export function toOutputMs(
  map: readonly TimeSegment[],
  sourceMs: number,
): number {
  const page = map.filter((s) => s.sourceEndMs > s.sourceStartMs);
  const first = page[0] ?? map[0];
  const last = page.at(-1) ?? map.at(-1);
  if (first === undefined || last === undefined) return 0;
  if (sourceMs <= first.sourceStartMs) return first.outputStartMs;
  if (sourceMs >= last.sourceEndMs) return last.outputEndMs;
  const segment =
    page.find((s) => sourceMs >= s.sourceStartMs && sourceMs < s.sourceEndMs) ??
    last;
  return lerp(
    sourceMs,
    segment.sourceStartMs,
    segment.sourceEndMs,
    segment.outputStartMs,
    segment.outputEndMs,
  );
}

/** Output ms → source ms, clamped to the map. */
export function toSourceMs(
  map: readonly TimeSegment[],
  outputMs: number,
): number {
  const first = map[0];
  const last = map.at(-1);
  if (first === undefined || last === undefined) return 0;
  if (outputMs <= first.outputStartMs) return first.sourceStartMs;
  if (outputMs >= last.outputEndMs) return last.sourceEndMs;
  const segment =
    map.find((s) => outputMs >= s.outputStartMs && outputMs < s.outputEndMs) ??
    last;
  return lerp(
    outputMs,
    segment.outputStartMs,
    segment.outputEndMs,
    segment.sourceStartMs,
    segment.sourceEndMs,
  );
}

/** Maps `value` from `[a0, a1]` onto `[b0, b1]`. */
function lerp(
  value: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): number {
  // Multiplied first: whole milliseconds on a 1:1 segment stay whole.
  return a1 === a0 ? b0 : b0 + ((value - a0) * (b1 - b0)) / (a1 - a0);
}
