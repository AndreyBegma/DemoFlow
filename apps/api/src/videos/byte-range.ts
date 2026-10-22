import type { VideoRange } from '../runner/runner-socket';

const SINGLE_RANGE = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/;

function count(digits: string): number | null {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * One `bytes=` range of a `Range` header. A multi-range, malformed or
 * backwards header is no range at all: the whole file goes with a 200, which
 * RFC 9110 allows (spec #191, Decision 3).
 */
export function parseRange(header: string | undefined): VideoRange | null {
  const match = header === undefined ? null : SINGLE_RANGE.exec(header);
  if (!match) {
    return null;
  }
  const [, first, last] = match;
  if (first === '') {
    const suffix = last === '' ? null : count(last);
    return suffix === null ? null : { suffix };
  }
  const start = count(first);
  if (start === null) {
    return null;
  }
  if (last === '') {
    return { start };
  }
  const end = count(last);
  return end === null || end < start ? null : { start, end };
}

/** The inclusive bytes of a file of `size` that `range` asks for; null when none. */
export function spanOf(
  range: VideoRange | null,
  size: number,
): { start: number; end: number } | null {
  if (size === 0) {
    return null;
  }
  if (range === null) {
    return { start: 0, end: size - 1 };
  }
  if ('suffix' in range) {
    return range.suffix === 0
      ? null
      : { start: Math.max(0, size - range.suffix), end: size - 1 };
  }
  if (range.start >= size) {
    return null;
  }
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}
