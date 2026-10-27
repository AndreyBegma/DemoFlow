import { cursorAt } from './frame.ts';
import type { CursorMove, Interval } from './types.ts';

/**
 * A cut where it joins the page (spec 354): `fromMs` and `toMs` in the page
 * ms of the map that plays the cut, `atMs` in page ms, where it plays in 0.
 */
export interface CutJoin {
  fromMs: number;
  toMs: number;
  atMs: number;
}

/**
 * Whether `[fromMs, toMs]` of the timeline lies inside one of `removed` —
 * the trim's head and tail and the cuts — so the page never shows it. An
 * instant on a cut's end shows: the page resumes there.
 */
export function hiddenBy(
  removed: readonly Interval[],
  fromMs: number,
  toMs = fromMs,
): boolean {
  return removed.some(
    (span) =>
      span.startMs <= fromMs && toMs <= span.endMs && fromMs < span.endMs,
  );
}

/**
 * Cursor moves in timeline ms cut at every removed span inside them (spec
 * 354, Decision 3): the cursor glides up to the span, then jumps to where it
 * is after it — to the move's end when the span outlasts the move, as a move
 * with no length on the span's end.
 */
export function splitMovesAt(
  moves: readonly CursorMove[],
  removed: readonly Interval[],
): CursorMove[] {
  return moves.flatMap((move) => {
    const pieces: CursorMove[] = [];
    let piece = move;
    for (const span of removed) {
      if (span.endMs <= piece.startMs || span.startMs >= piece.endMs) continue;
      if (span.startMs > piece.startMs) {
        const point = cursorAt([move], span.startMs) ?? move.from;
        pieces.push({ ...piece, endMs: span.startMs, to: point });
      }
      if (span.endMs >= move.endMs) {
        // The tail of the trim: nothing after it plays.
        if (span.endMs === Infinity) return pieces;
        piece = {
          startMs: span.endMs,
          endMs: span.endMs,
          from: move.to,
          to: move.to,
        };
        break;
      }
      const point = cursorAt([move], span.endMs) ?? move.to;
      piece = { ...piece, startMs: span.endMs, from: point };
    }
    pieces.push(piece);
    return pieces;
  });
}

/**
 * Keyframes planned on the map that plays the cuts, moved onto the page
 * (spec 354, Decision 3): the keys inside a cut go, and the camera holds its
 * state on the cut across the join — like across a card — then settles over
 * `settleMs` on where the cut left it, unless a key after the cut comes
 * sooner. So a zoom that starts inside a cut starts at the cut's end.
 */
export function holdAcrossCuts<K extends { atMs: number }>(
  keys: readonly K[],
  joins: readonly CutJoin[],
  toPage: (ms: number) => number,
  hold: (ms: number, atMs: number) => K,
  settleMs: number,
): K[] {
  const first = keys[0];
  const last = keys.at(-1);
  if (joins.length === 0 || first === undefined || last === undefined) {
    return [...keys];
  }
  const inside = (ms: number): boolean =>
    joins.some((join) => ms > join.fromMs && ms <= join.toMs);
  const out = keys
    .filter((key) => !inside(key.atMs))
    .map((key) => ({ ...key, atMs: toPage(key.atMs) }));
  for (const [index, join] of joins.entries()) {
    if (join.toMs <= first.atMs || join.fromMs >= last.atMs) continue;
    out.push(hold(join.fromMs, join.atMs));
    const after = keys.find((key) => key.atMs > join.toMs);
    const settleAt = Math.min(
      join.atMs + settleMs,
      joins[index + 1]?.atMs ?? Infinity,
    );
    if (after === undefined || toPage(after.atMs) > settleAt) {
      out.push(hold(join.toMs, settleAt));
    }
  }
  // Stable: a hold comes after a key on the same instant.
  return out.sort((a, b) => a.atMs - b.atMs);
}
