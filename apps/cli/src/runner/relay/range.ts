/** `range` of `video.open`: the API's parsed `Range` header (spec 191). */
export type VideoRange = { start: number; end?: number } | { suffix: number };

/** The inclusive bytes to send. */
export interface ByteSpan {
  start: number;
  end: number;
}

/**
 * Decision 5: HTTP semantics against the file's size. `null` is the whole
 * file. `'bad-range'` is unsatisfiable, and the answer carries the size.
 * An empty file has no inclusive span to put in `video.head`, so it is
 * unsatisfiable even whole — as the API's `spanOf` (#191) has it.
 */
export function resolveRange(
  range: VideoRange | null,
  size: number,
): ByteSpan | 'bad-range' {
  if (size === 0) return 'bad-range';
  if (range === null) return { start: 0, end: size - 1 };
  if ('suffix' in range) {
    if (range.suffix === 0) return 'bad-range';
    return { start: size - Math.min(range.suffix, size), end: size - 1 };
  }
  if (range.start >= size) return 'bad-range';
  const end = Math.min(range.end ?? size - 1, size - 1);
  // `bytes=5-3` never reaches here from the API's parser; refuse it anyway.
  if (end < range.start) return 'bad-range';
  return { start: range.start, end };
}

/** A non-negative safe integer, as every offset in a range must be. */
function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The `range` field of a `video.open`, or `undefined` when malformed. */
export function parseRange(value: unknown): VideoRange | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if ('suffix' in fields) {
    if (Object.keys(fields).length !== 1 || !isOffset(fields.suffix)) {
      return undefined;
    }
    return { suffix: fields.suffix };
  }
  const known = Object.keys(fields).every(
    (key) => key === 'start' || key === 'end',
  );
  if (!known || !isOffset(fields.start)) return undefined;
  if (fields.end === undefined) return { start: fields.start };
  return isOffset(fields.end)
    ? { start: fields.start, end: fields.end }
    : undefined;
}
