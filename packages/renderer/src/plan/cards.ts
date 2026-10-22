import type { CardsConfig, TimelineEvent } from '@demoflow/core';
import { cameraStateAt, cursorAt, followAt, maskBoxAt } from './frame.ts';
import { type CardSlot, shiftPastCards } from './time-map.ts';
import type {
  CameraKeyframe,
  Caption,
  CardSpec,
  ClickRing,
  CursorMove,
  FollowKey,
  KeyBadge,
  MaskSpan,
} from './types.ts';

/** A card where it cuts the page: `atMs` in page ms, `startMs` in output ms. */
export type PlacedCard = CardSpec & CardSlot;

/**
 * The cards of a run, in page order (spec 108): the intro at the start, a
 * card on every `scene` marker before the page ends, and — on a successful
 * run with a title — the outro after it. `out` maps timeline ms to page ms.
 */
export function placeCards(input: {
  config?: CardsConfig;
  events: readonly TimelineEvent[];
  out: (timelineMs: number) => number;
  pageEndMs: number;
  scenarioName: string;
  description?: string;
  failed: boolean;
}): PlacedCard[] {
  const { config, events, out, pageEndMs } = input;
  if (config === undefined) return [];
  const cards: Omit<PlacedCard, 'startMs'>[] = [];
  if (config.intro.enabled) {
    const subtitle = input.description?.trim();
    cards.push({
      kind: 'intro',
      atMs: 0,
      durationMs: config.intro.durationMs,
      title: input.scenarioName,
      ...(subtitle === undefined || subtitle === '' ? {} : { subtitle }),
    });
  }
  if (config.scenes.enabled) {
    for (const event of events) {
      if (event.marker?.kind !== 'scene') continue;
      const atMs = out(event.startMs);
      // After a failure the page has ended; the marker never showed.
      if (atMs >= pageEndMs) continue;
      cards.push({
        kind: 'scene',
        atMs,
        durationMs: config.scenes.durationMs,
        title: event.marker.title,
      });
    }
  }
  const { outro } = config;
  if (!input.failed && outro.title !== undefined) {
    cards.push({
      kind: 'outro',
      atMs: pageEndMs,
      durationMs: outro.durationMs,
      title: outro.title,
      ...(outro.cta === undefined ? {} : { subtitle: outro.cta }),
    });
  }
  // Stable: the intro stays before a scene marker at the very start.
  cards.sort((a, b) => a.atMs - b.atMs);
  let inserted = 0;
  return cards.map((card) => {
    const placed = { ...card, startMs: card.atMs + inserted };
    inserted += card.durationMs;
    return placed;
  });
}

/** Everything drawn over the page, in output ms. */
export interface Overlays {
  cursor: CursorMove[];
  clicks: ClickRing[];
  camera: CameraKeyframe[];
  /** The vertical output's follow camera (spec 176). */
  follow: FollowKey[];
  masks: MaskSpan[];
  captions: Caption[];
  keys: KeyBadge[];
}

/**
 * Moves overlays planned in page ms past the cards (spec 108, Decision 1).
 * Every lead, trail and tail was added in page time, so a mask that covered
 * the page up to a cut covers it again after the card. A span across a cut
 * stretches over the card, which draws none of it. What moves — the camera, a
 * mask's box, the cursor — is held at its state on the cut through the card,
 * so the page frame after a card is the one before it; an eased move cut in
 * two eases into the cut and out of it. A click ring under way at a cut runs
 * out behind the card.
 */
export function shiftOverlays(
  overlays: Overlays,
  cards: readonly PlacedCard[],
): Overlays {
  if (cards.length === 0) return overlays;
  const at = (ms: number): number => shiftPastCards(cards, ms);
  const until = (ms: number): number =>
    shiftPastCards(cards, ms, { end: true });
  const span = <T extends { startMs: number; endMs: number }>(item: T): T => ({
    ...item,
    startMs: at(item.startMs),
    endMs: Math.max(at(item.startMs), until(item.endMs)),
  });

  return {
    cursor: splitMoves(overlays.cursor, cards).map(span),
    clicks: overlays.clicks.map((ring) => ({ ...ring, atMs: at(ring.atMs) })),
    camera: holdAcross(overlays.camera, cards, at, (pageMs, atMs) => ({
      atMs,
      ...cameraStateAt(overlays.camera, pageMs),
    })),
    follow: holdAcross(overlays.follow, cards, at, (pageMs, atMs) => ({
      atMs,
      x: followAt(overlays.follow, pageMs) ?? 0,
    })),
    masks: overlays.masks.map((mask) => ({
      ...span(mask),
      keys: holdAcross(mask.keys, cards, at, (pageMs, atMs) => ({
        atMs,
        box: maskBoxAt(mask, pageMs),
      })),
    })),
    captions: overlays.captions.map(span),
    keys: overlays.keys.map(span),
  };
}

/**
 * Keyframes in output ms, with two more for every card cutting between the
 * first and the last: `hold` on the cut, at the card's start and at its end.
 */
function holdAcross<K extends { atMs: number }>(
  keys: readonly K[],
  cards: readonly PlacedCard[],
  at: (pageMs: number) => number,
  hold: (pageMs: number, atMs: number) => K,
): K[] {
  const first = keys[0];
  const last = keys.at(-1);
  if (first === undefined || last === undefined) return [];
  const out: K[] = [];
  let next = 0;
  const holdUntil = (pageMs: number): void => {
    while (next < cards.length && cards[next].atMs <= pageMs) {
      const card = cards[next++];
      if (card.atMs <= first.atMs || card.atMs > last.atMs) continue;
      out.push(hold(card.atMs, card.startMs));
      out.push(hold(card.atMs, card.startMs + card.durationMs));
    }
  };
  for (const key of keys) {
    holdUntil(key.atMs);
    out.push({ ...key, atMs: at(key.atMs) });
  }
  return out;
}

/** Cursor moves cut in two at every card inside them, meeting where the cursor was on the cut. */
function splitMoves(
  moves: readonly CursorMove[],
  cards: readonly PlacedCard[],
): CursorMove[] {
  return moves.flatMap((move) => {
    const pieces: CursorMove[] = [];
    let piece = move;
    for (const card of cards) {
      if (card.atMs <= piece.startMs || card.atMs >= piece.endMs) continue;
      const point = cursorAt([move], card.atMs) ?? move.from;
      pieces.push({ ...piece, endMs: card.atMs, to: point });
      piece = { ...piece, startMs: card.atMs, from: point };
    }
    pieces.push(piece);
    return pieces;
  });
}
