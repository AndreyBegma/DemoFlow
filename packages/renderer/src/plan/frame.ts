import type { Box } from '@demoflow/core';
import { toSourceMs } from './time-map.ts';
import type {
  CameraKeyframe,
  CropSpec,
  CursorMove,
  FollowKey,
  FrameState,
  MaskSpan,
  Point,
  RenderPlan,
} from './types.ts';

/**
 * Which picture a frame is for: the landscape output every format but one
 * shares, the 9:16 crop of the `*-vertical` formats (spec 176), or the 1:1
 * crop of the `*-square` ones (spec 304).
 */
export type Layout = 'landscape' | 'vertical' | 'square';

/** How many frames the video has. */
export function frameCount(plan: RenderPlan): number {
  return Math.max(1, Math.round((plan.durationMs / 1000) * plan.output.fps));
}

/** Ease-in-out (cubic), from 0 at 0 to 1 at 1. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Everything to draw on output frame `frame` — the one interpretation of the
 * plan both renderers share, so they differ in drawing, not in timing. The
 * vertical layout differs only in geometry: the same cards, holds, overlays
 * and captions at the same times (spec 176).
 */
export function frameAt(
  plan: RenderPlan,
  frame: number,
  layout: Layout = 'landscape',
): FrameState {
  const atMs = (frame * 1000) / plan.output.fps;
  const card = plan.failure?.endCard;
  const watermark = plan.failure !== undefined;
  const view = viewOf(plan, layout);

  // No fade into the failure card (spec 114, Decision 4).
  if (card !== undefined && atMs >= card.startMs) {
    const { crop, content, scale, stage } = view.geometryAt(card.startMs);
    return {
      sourceMs: null,
      crop,
      content,
      scale,
      ...(stage === undefined ? {} : { frame: stage }),
      rings: [],
      masks: [],
      watermark,
      endCard: card.text,
    };
  }

  // Cards are inserted time (spec 108): no page, no overlay, the camera at zoom 1.
  const titleCard = plan.cards.find(
    (entry) => atMs >= entry.startMs && atMs < entry.startMs + entry.durationMs,
  );
  if (titleCard !== undefined) {
    const state: FrameState = {
      ...backgroundAt(plan, view),
      card: {
        title: titleCard.title,
        ...(titleCard.subtitle === undefined
          ? {}
          : { subtitle: titleCard.subtitle }),
        background: plan.cardBackground,
      },
    };
    const fade = cardFade(plan, view, titleCard, atMs);
    return fade === undefined ? state : { ...state, fade };
  }

  return pageAt(plan, view, atMs);
}

/** A layout's frame size and where the page lands on it over time. */
interface View {
  width: number;
  height: number;
  geometryAt: (atMs: number) => Geometry;
}

function viewOf(plan: RenderPlan, layout: Layout): View {
  if (layout === 'landscape') {
    return {
      width: plan.output.width,
      height: plan.output.height,
      geometryAt: (atMs) => geometryAt(plan, atMs),
    };
  }
  const crop = layout === 'vertical' ? plan.vertical : plan.square;
  if (crop === undefined) {
    throw new Error(`a ${layout} frame needs a plan with a ${layout} format`);
  }
  return {
    width: crop.width,
    height: crop.height,
    geometryAt: (atMs) => cropGeometryAt(plan, crop, atMs),
  };
}

/** Nothing of the page: the background, at zoom 1 — the window as the stage shows it. */
function backgroundAt(plan: RenderPlan, view: View): FrameState {
  // Before every camera key, so at zoom 1.
  const { content, scale } = view.geometryAt(-1);
  return {
    sourceMs: null,
    crop: { x: 0, y: 0, width: plan.source.width, height: plan.source.height },
    content,
    scale,
    rings: [],
    masks: [],
    watermark: plan.failure !== undefined,
  };
}

/**
 * A card dissolves with the page inside its own time (spec 114, Decision 2):
 * a scene or outro card in from the page frame just before it, an intro or
 * scene card out into the page frame just after it. The page frame is the
 * page at the cut, everything on it as it was there — or a held frame, when
 * a page load holds across the cut. The card is always the frame on top, so
 * a page frame that is itself mid-dissolve keeps its own fade.
 */
function cardFade(
  plan: RenderPlan,
  view: View,
  card: RenderPlan['cards'][number],
  atMs: number,
): FrameState['fade'] {
  const fadeMs = plan.transitions?.durationMs;
  if (fadeMs === undefined || fadeMs <= 0) return undefined;
  const endMs = card.startMs + card.durationMs;
  if (card.kind !== 'intro' && atMs < card.startMs + fadeMs) {
    return {
      from: pageAt(plan, view, card.startMs - CUT_EPSILON_MS),
      progress: (atMs - card.startMs) / fadeMs,
    };
  }
  if (card.kind !== 'outro' && atMs >= endMs - fadeMs) {
    return {
      from: pageAt(plan, view, endMs),
      progress: (endMs - atMs) / fadeMs,
    };
  }
  return undefined;
}

/** The page frame just before a cut: an instant there still belongs to the page. */
const CUT_EPSILON_MS = 1e-6;

/**
 * The page at `atMs`: the live page, or — while a page load holds (spec 114)
 * — the held frame, dissolving into the live page once it is ready.
 */
function pageAt(plan: RenderPlan, view: View, atMs: number): FrameState {
  const live = liveAt(plan, view, atMs);
  const hold = plan.transitions?.holds.find(
    (entry) => atMs >= entry.startMs && atMs < entry.fadeEndMs,
  );
  if (hold === undefined) return live;
  const held: FrameState =
    hold.sourceMs === undefined
      ? { ...backgroundAt(plan, view), backdrop: plan.cardBackground }
      : {
          ...live,
          sourceMs: hold.sourceMs,
          // The held page's masks, where the camera now shows that page.
          masks: maskBoxes(hold.masks, view.geometryAt(atMs), view),
        };
  if (atMs < hold.endMs || hold.fadeMs <= 0) return held;
  const progress = pageMsBetween(plan, hold.endMs, atMs) / hold.fadeMs;
  return { ...live, fade: { from: held, progress: Math.min(1, progress) } };
}

/** Output ms from `fromMs` to `toMs`, less the cards between: page time. */
function pageMsBetween(plan: RenderPlan, fromMs: number, toMs: number): number {
  let ms = toMs - fromMs;
  for (const card of plan.cards) {
    const start = Math.max(fromMs, card.startMs);
    const end = Math.min(toMs, card.startMs + card.durationMs);
    if (end > start) ms -= end - start;
  }
  return ms;
}

/** Viewport boxes on the frame: through the camera, clipped to the window and the output frame. */
function maskBoxes(
  boxes: readonly Box[],
  { toOutput, scale, content }: Geometry,
  output: { width: number; height: number },
): Box[] {
  const screen: Box = {
    x: 0,
    y: 0,
    width: output.width,
    height: output.height,
  };
  return boxes.flatMap((box) => {
    const corner = toOutput(box);
    const inWindow = intersect(
      {
        x: corner.x,
        y: corner.y,
        width: box.width * scale,
        height: box.height * scale,
      },
      content,
    );
    const clipped = inWindow && intersect(inWindow, screen);
    return clipped === undefined ? [] : [clipped];
  });
}

/** The live page at `atMs`, with everything drawn over it. */
function liveAt(plan: RenderPlan, view: View, atMs: number): FrameState {
  const geometry = view.geometryAt(atMs);
  const { crop, content, scale, toOutput, stage } = geometry;
  const watermark = plan.failure !== undefined;
  const cursor = cursorAt(plan.cursor, atMs);
  const rings = plan.clicks.flatMap((ring) => {
    const progress = (atMs - ring.atMs) / ring.durationMs;
    return progress >= 0 && progress < 1
      ? [{ point: toOutput(ring.point), progress }]
      : [];
  });
  const masks = maskBoxes(
    plan.masks.flatMap((mask) =>
      atMs < mask.startMs || atMs >= mask.endMs ? [] : [maskBoxAt(mask, atMs)],
    ),
    geometry,
    view,
  );
  const caption = plan.captions.find(
    (entry) => atMs >= entry.startMs && atMs < entry.endMs,
  )?.text;
  const badge = plan.keys.find(
    (entry) => atMs >= entry.startMs && atMs < entry.endMs,
  );

  return {
    sourceMs: toSourceMs(plan.timeMap, atMs),
    crop,
    content,
    scale,
    ...(stage === undefined ? {} : { frame: stage }),
    ...(cursor === undefined ? {} : { cursor: toOutput(cursor) }),
    rings,
    masks,
    ...(caption === undefined ? {} : { caption }),
    ...(badge === undefined
      ? {}
      : { key: { text: badge.text, anchor: toOutput(badge.anchor) } }),
    watermark,
  };
}

interface Geometry {
  crop: Box;
  content: Box;
  scale: number;
  /** Viewport CSS pixels → output pixels on this frame. */
  toOutput: (point: Point) => Point;
  stage?: { view: Box; radius: number };
}

/**
 * Where the page lands on the frame at `atMs` (spec 100, Decision 3).
 * Without a frame the camera crops the viewport and the crop fills
 * `plan.fit`. With one it moves over the stage — the background and the
 * window at `plan.fit` — so the whole source is drawn into the window and
 * everything mapped through `toOutput` moves and scales with it.
 */
function geometryAt(plan: RenderPlan, atMs: number): Geometry {
  const { fit, viewport, source } = plan;
  if (plan.frame === undefined) {
    const view = cameraAt(plan, atMs);
    const content: Box = {
      x: fit.x,
      y: fit.y,
      width: viewport.width * fit.scale,
      height: viewport.height * fit.scale,
    };
    const scale = content.width / view.width;
    return {
      crop: {
        x: view.x * source.scale,
        y: view.y * source.scale,
        width: view.width * source.scale,
        height: view.height * source.scale,
      },
      content,
      scale,
      toOutput: (point) => ({
        x: content.x + (point.x - view.x) * scale,
        y: content.y + (point.y - view.y) * scale,
      }),
    };
  }
  const view = stageViewAt(plan, atMs);
  // Output pixels per stage pixel: the camera's zoom.
  const zoom = plan.output.width / view.width;
  const scale = fit.scale * zoom;
  const toOutput = (point: Point): Point => ({
    x: (fit.x + point.x * fit.scale - view.x) * zoom,
    y: (fit.y + point.y * fit.scale - view.y) * zoom,
  });
  return {
    crop: { x: 0, y: 0, width: source.width, height: source.height },
    content: {
      ...toOutput({ x: 0, y: 0 }),
      width: viewport.width * scale,
      height: viewport.height * scale,
    },
    scale,
    toOutput,
    stage: { view, radius: plan.frame.radius * zoom },
  };
}

/**
 * The part of the stage the camera shows at `atMs`, in stage pixels: zoom 1
 * is the whole stage, a zoom centres the target as far as the stage's edges
 * allow, so the background may leave the frame.
 */
export function stageViewAt(plan: RenderPlan, atMs: number): Box {
  const { centre, zoom } = cameraStateAt(plan.camera, atMs);
  const { width: sw, height: sh } = plan.output;
  const { fit } = plan;
  const width = sw / zoom;
  const height = sh / zoom;
  const x = fit.x + centre.x * fit.scale;
  const y = fit.y + centre.y * fit.scale;
  return {
    x: Math.min(sw - width, Math.max(0, x - width / 2)),
    y: Math.min(sh - height, Math.max(0, y - height / 2)),
    width,
    height,
  };
}

/**
 * The vertical and square outputs (specs 176, 304): the crop `cropViewAt`
 * gives fills the frame. No window, no background: the page is all there is.
 */
function cropGeometryAt(
  plan: RenderPlan,
  vertical: CropSpec,
  atMs: number,
): Geometry {
  const { source } = plan;
  const view = cropViewAt(plan, vertical, atMs);
  const scale = vertical.width / view.width;
  return {
    crop: {
      x: view.x * source.scale,
      y: view.y * source.scale,
      width: view.width * source.scale,
      height: view.height * source.scale,
    },
    content: { x: 0, y: 0, width: vertical.width, height: vertical.height },
    scale,
    toOutput: (point) => ({
      x: (point.x - view.x) * scale,
      y: (point.y - view.y) * scale,
    }),
  };
}

/**
 * A crop (9:16 or 1:1) at zoom 1, in viewport CSS pixels: the full viewport
 * height and the output's aspect ratio — or, on a viewport narrower than
 * that, its full width.
 */
export function cropSize(
  viewport: { width: number; height: number },
  output: { width: number; height: number },
): { width: number; height: number } {
  const aspect = output.width / output.height;
  const height = Math.min(viewport.height, viewport.width / aspect);
  return { width: height * aspect, height };
}

/**
 * The part of the viewport a crop output shows at `atMs`: centred
 * across on the follow camera and down on the steps' camera, narrowed by
 * its zoom, and clamped to the page — it never leaves it.
 */
export function cropViewAt(
  plan: RenderPlan,
  vertical: CropSpec,
  atMs: number,
): Box {
  const { viewport } = plan;
  const { centre, zoom } = cameraStateAt(plan.camera, atMs);
  const base = cropSize(viewport, vertical);
  const width = base.width / zoom;
  const height = base.height / zoom;
  const x = followAt(vertical.follow, atMs) ?? viewport.width / 2;
  return {
    x: Math.min(viewport.width - width, Math.max(0, x - width / 2)),
    y: Math.min(viewport.height - height, Math.max(0, centre.y - height / 2)),
    width,
    height,
  };
}

/** The follow camera's horizontal centre at `atMs`, eased between keys; `undefined` without keys. */
export function followAt(
  keys: readonly FollowKey[],
  atMs: number,
): number | undefined {
  const next = keys.findIndex((key) => key.atMs > atMs);
  if (next === 0) return keys[0].x;
  if (next === -1) return keys.at(-1)?.x;
  const a = keys[next - 1];
  const b = keys[next];
  return a.x + (b.x - a.x) * easeInOut((atMs - a.atMs) / (b.atMs - a.atMs));
}

/** The part of the viewport the camera shows at `atMs`, in viewport CSS pixels. */
export function cameraAt(plan: RenderPlan, atMs: number): Box {
  const { centre, zoom } = cameraStateAt(plan.camera, atMs);
  const { width: vw, height: vh } = plan.viewport;
  const width = vw / zoom;
  const height = vh / zoom;
  return {
    x: Math.min(vw - width, Math.max(0, centre.x - width / 2)),
    y: Math.min(vh - height, Math.max(0, centre.y - height / 2)),
    width,
    height,
  };
}

export function cameraStateAt(
  keys: readonly CameraKeyframe[],
  atMs: number,
): { centre: Point; zoom: number } {
  const next = keys.findIndex((key) => key.atMs > atMs);
  if (next === 0 || keys.length === 0) {
    return { centre: keys[0]?.centre ?? { x: 0, y: 0 }, zoom: 1 };
  }
  if (next === -1) {
    const last = keys[keys.length - 1];
    return { centre: last.centre, zoom: last.zoom };
  }
  const a = keys[next - 1];
  const b = keys[next];
  const t = easeInOut((atMs - a.atMs) / (b.atMs - a.atMs));
  return {
    centre: mix(a.centre, b.centre, t),
    zoom: a.zoom + (b.zoom - a.zoom) * t,
  };
}

/** Hidden before the first move; glides during a move; rests between moves. */
export function cursorAt(
  moves: readonly CursorMove[],
  atMs: number,
): Point | undefined {
  let current: CursorMove | undefined;
  for (const move of moves) {
    if (move.startMs > atMs) break;
    current = move;
  }
  if (current === undefined) return undefined;
  const length = current.endMs - current.startMs;
  const t = length <= 0 ? 1 : easeInOut((atMs - current.startMs) / length);
  return mix(current.from, current.to, t);
}

export function maskBoxAt(mask: MaskSpan, atMs: number): Box {
  const next = mask.keys.findIndex((key) => key.atMs > atMs);
  if (next === 0) return mask.keys[0].box;
  if (next === -1) return mask.keys[mask.keys.length - 1].box;
  const a = mask.keys[next - 1];
  const b = mask.keys[next];
  const t = b.atMs === a.atMs ? 1 : (atMs - a.atMs) / (b.atMs - a.atMs);
  return { ...a.box, ...mix(a.box, b.box, t) };
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function intersect(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : undefined;
}
