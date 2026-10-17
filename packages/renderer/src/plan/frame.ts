import type { Box } from '@demoflow/core';
import { toSourceMs } from './time-map.ts';
import type {
  CameraKeyframe,
  CursorMove,
  FrameState,
  MaskSpan,
  Point,
  RenderPlan,
} from './types.ts';

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
 * plan both renderers share, so they differ in drawing, not in timing.
 */
export function frameAt(plan: RenderPlan, frame: number): FrameState {
  const atMs = (frame * 1000) / plan.output.fps;
  const card = plan.failure?.endCard;
  const onCard = card !== undefined && atMs >= card.startMs;
  const view = cameraAt(plan, onCard ? card.startMs : atMs);
  const { fit, viewport, source } = plan;
  const content: Box = {
    x: fit.x,
    y: fit.y,
    width: viewport.width * fit.scale,
    height: viewport.height * fit.scale,
  };
  const scale = content.width / view.width;
  const toOutput = (point: Point): Point => ({
    x: content.x + (point.x - view.x) * scale,
    y: content.y + (point.y - view.y) * scale,
  });
  const crop: Box = {
    x: view.x * source.scale,
    y: view.y * source.scale,
    width: view.width * source.scale,
    height: view.height * source.scale,
  };
  const watermark = plan.failure !== undefined;

  if (onCard) {
    return {
      sourceMs: null,
      crop,
      content,
      scale,
      rings: [],
      masks: [],
      watermark,
      endCard: card.text,
    };
  }

  const cursor = cursorAt(plan.cursor, atMs);
  const rings = plan.clicks.flatMap((ring) => {
    const progress = (atMs - ring.atMs) / ring.durationMs;
    return progress >= 0 && progress < 1
      ? [{ point: toOutput(ring.point), progress }]
      : [];
  });
  const masks = plan.masks.flatMap((mask) => {
    if (atMs < mask.startMs || atMs >= mask.endMs) return [];
    const box = maskBoxAt(mask, atMs);
    const corner = toOutput(box);
    const clipped = intersect(
      {
        x: corner.x,
        y: corner.y,
        width: box.width * scale,
        height: box.height * scale,
      },
      content,
    );
    return clipped === undefined ? [] : [clipped];
  });
  const caption = plan.captions.find(
    (entry) => atMs >= entry.startMs && atMs < entry.endMs,
  )?.text;

  return {
    sourceMs: toSourceMs(plan.timeMap, atMs),
    crop,
    content,
    scale,
    ...(cursor === undefined ? {} : { cursor: toOutput(cursor) }),
    rings,
    masks,
    ...(caption === undefined ? {} : { caption }),
    watermark,
  };
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

function cameraStateAt(
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

function maskBoxAt(mask: MaskSpan, atMs: number): Box {
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
