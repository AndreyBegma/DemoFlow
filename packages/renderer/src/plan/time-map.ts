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
 * The time map: source `[0, endMs]` in order, real time except the idle
 * stretches, which each play in `compressToMs`.
 */
export function buildTimeMap(
  idle: readonly Interval[],
  endMs: number,
  compressToMs: number,
): TimeSegment[] {
  const segments: TimeSegment[] = [];
  let source = 0;
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
  for (const stretch of idle) {
    if (stretch.startMs >= endMs) break;
    push(stretch.startMs, stretch.startMs - source);
    const stretchEnd = Math.min(stretch.endMs, endMs);
    push(stretchEnd, Math.min(compressToMs, stretchEnd - stretch.startMs));
  }
  push(endMs, endMs - source);
  return segments;
}

/** Source ms → output ms, clamped to the map. */
export function toOutputMs(
  map: readonly TimeSegment[],
  sourceMs: number,
): number {
  const first = map[0];
  const last = map.at(-1);
  if (first === undefined || last === undefined) return 0;
  if (sourceMs <= first.sourceStartMs) return first.outputStartMs;
  if (sourceMs >= last.sourceEndMs) return last.outputEndMs;
  const segment =
    map.find((s) => sourceMs >= s.sourceStartMs && sourceMs < s.sourceEndMs) ??
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
  return a1 === a0 ? b0 : b0 + ((value - a0) / (a1 - a0)) * (b1 - b0);
}
