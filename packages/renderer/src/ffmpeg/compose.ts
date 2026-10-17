import type { Box } from '@demoflow/core';
import type { FrameState, OutputSpec } from '../plan/types.ts';
import {
  descent,
  lineHeight,
  measureText,
  type TextStyle,
  textSegments,
  wrapText,
} from './font.ts';
import {
  blurBox,
  type Colour,
  drawScaled,
  edge,
  fill,
  fillBox,
  hex,
  type Mask,
  type Picture,
  paint,
  paintMask,
  polygonDistance,
  roundRectDistance,
  strokeMask,
} from './raster.ts';

const WHITE = hex('#ffffff');
const BLACK = hex('#000000');

/**
 * The look both renderers share (agreed for spec 4): output pixels, times the
 * frame's `scale` for the cursor and the rings. Text sizes are cap heights.
 */
export const LOOK = {
  mask: { sigma: 12, wash: hex('#808080'), washAlpha: 0.35 },
  cursor: { fill: WHITE, outline: hex('#111111'), outlineWidth: 2 },
  ring: { colour: WHITE, width: 4, fromRadius: 12, toRadius: 36 },
  caption: {
    panel: BLACK,
    panelAlpha: 0.6,
    padding: 16,
    radius: 12,
    bottom: 64,
    maxWidth: 1600,
    text: { capHeight: 40, weight: 4 },
  },
  watermark: {
    fill: hex('#d93025'),
    margin: 24,
    paddingX: 16,
    paddingY: 8,
    radius: 12,
    label: 'FAILED',
    text: { capHeight: 32, weight: 6 },
  },
  endCard: {
    background: hex('#111111'),
    maxWidth: 1600,
    text: { capHeight: 48, weight: 5 },
  },
} as const;

/**
 * The arrow cursor at `scale` 1, 28 px tall, its tip at (0, 0). The outline
 * is drawn outside this shape.
 */
const ARROW = [
  { x: 0, y: 0 },
  { x: 0, y: 23 },
  { x: 5.5, y: 18 },
  { x: 9.5, y: 27.6 },
  { x: 13.2, y: 26 },
  { x: 9.3, y: 16.6 },
  { x: 16.6, y: 16.6 },
];

/** A block of text laid out once: its mask, with the panel it sits on. */
interface Laid {
  mask: Mask;
  panel: Box;
}

/**
 * Draws frames of one output size. Text is laid out once per string and
 * reused, since a caption stays on screen for many frames.
 */
export interface Compositor {
  /** Draws `state` into `target`; `source` is the source frame for `state.sourceMs`, absent on the end card. */
  compose(target: Picture, state: FrameState, source?: Picture): void;
}

export function createCompositor(output: OutputSpec): Compositor {
  const captions = new Map<string, Laid>();
  const cards = new Map<string, Laid>();
  const badge = layBadge(output);

  return {
    compose(target, state, source) {
      if (state.endCard !== undefined) {
        fill(target, LOOK.endCard.background);
        const card = cached(cards, state.endCard, (text) =>
          layEndCard(text, output),
        );
        paintMask(target, card.mask, WHITE);
      } else {
        fill(target, BLACK);
        if (source !== undefined) {
          drawScaled(target, source, state.crop, state.content);
        }
        for (const box of state.masks) {
          blurBox(target, box, LOOK.mask.sigma);
          fillBox(target, box, LOOK.mask.wash, LOOK.mask.washAlpha);
        }
        for (const ring of state.rings) {
          drawRing(target, ring.point, ring.progress, state.scale);
        }
        if (state.cursor !== undefined) {
          drawCursor(target, state.cursor, state.scale);
        }
        if (state.caption !== undefined) {
          const caption = cached(captions, state.caption, (text) =>
            layCaption(text, output),
          );
          const { panel } = LOOK.caption;
          drawPanel(target, caption.panel, panel, LOOK.caption.panelAlpha);
          paintMask(target, caption.mask, WHITE);
        }
      }
      if (state.watermark) {
        drawPanel(target, badge.panel, LOOK.watermark.fill, 1);
        paintMask(target, badge.mask, WHITE);
      }
    },
  };
}

function cached(
  store: Map<string, Laid>,
  text: string,
  lay: (text: string) => Laid,
): Laid {
  let laid = store.get(text);
  if (laid === undefined) {
    laid = lay(text);
    store.set(text, laid);
  }
  return laid;
}

function drawRing(
  target: Picture,
  point: { x: number; y: number },
  progress: number,
  scale: number,
): void {
  const { colour, width, fromRadius, toRadius } = LOOK.ring;
  const radius = (fromRadius + (toRadius - fromRadius) * progress) * scale;
  const half = (width * scale) / 2;
  const reach = radius + half + 1;
  paint(
    target,
    {
      x: point.x - reach,
      y: point.y - reach,
      width: reach * 2,
      height: reach * 2,
    },
    colour,
    1 - progress,
    (x, y) =>
      edge(half - Math.abs(Math.hypot(x - point.x, y - point.y) - radius)),
  );
}

function drawCursor(
  target: Picture,
  tip: { x: number; y: number },
  scale: number,
): void {
  const shape = ARROW.map((p) => ({
    x: tip.x + p.x * scale,
    y: tip.y + p.y * scale,
  }));
  const outline = LOOK.cursor.outlineWidth * scale;
  const xs = shape.map((p) => p.x);
  const ys = shape.map((p) => p.y);
  const bounds: Box = {
    x: Math.min(...xs) - outline - 1,
    y: Math.min(...ys) - outline - 1,
    width: Math.max(...xs) - Math.min(...xs) + 2 * outline + 2,
    height: Math.max(...ys) - Math.min(...ys) + 2 * outline + 2,
  };
  paint(target, bounds, LOOK.cursor.outline, 1, (x, y) =>
    edge(outline - polygonDistance(shape, x, y)),
  );
  paint(target, bounds, LOOK.cursor.fill, 1, (x, y) =>
    edge(-polygonDistance(shape, x, y)),
  );
}

function drawPanel(
  target: Picture,
  panel: Box,
  colour: Colour,
  alpha: number,
): void {
  const radius = Math.min(LOOK.caption.radius, panel.height / 2);
  paint(target, panel, colour, alpha, (x, y) =>
    edge(-roundRectDistance(panel, radius, x, y)),
  );
}

/** Lines of text, each centred on `centreX`, the first baseline at `baseline`. */
function textMask(
  lines: readonly string[],
  style: TextStyle,
  centreX: number,
  baseline: number,
): Mask {
  const segments = lines.flatMap((line, index) =>
    textSegments(
      line,
      style,
      centreX - measureText(line, style) / 2,
      baseline + index * lineHeight(style),
    ),
  );
  return strokeMask(segments, style.weight);
}

/** The height of `lines` from the first cap top to the last descender. */
function blockHeight(lines: readonly string[], style: TextStyle): number {
  return (
    (lines.length - 1) * lineHeight(style) + style.capHeight + descent(style)
  );
}

function layCaption(text: string, output: OutputSpec): Laid {
  const { padding, bottom, maxWidth, text: style } = LOOK.caption;
  const lines = wrapText(text, style, maxWidth - 2 * padding);
  const width =
    Math.max(...lines.map((line) => measureText(line, style))) + 2 * padding;
  const height = blockHeight(lines, style) + 2 * padding;
  const panel: Box = {
    x: (output.width - width) / 2,
    y: output.height - bottom - height,
    width,
    height,
  };
  return {
    panel,
    mask: textMask(
      lines,
      style,
      output.width / 2,
      panel.y + padding + style.capHeight,
    ),
  };
}

function layBadge(output: OutputSpec): Laid {
  const { margin, paddingX, paddingY, label, text: style } = LOOK.watermark;
  const width = measureText(label, style) + 2 * paddingX;
  const height = style.capHeight + 2 * paddingY;
  const panel: Box = {
    x: output.width - margin - width,
    y: margin,
    width,
    height,
  };
  return {
    panel,
    mask: textMask(
      [label],
      style,
      panel.x + width / 2,
      panel.y + paddingY + style.capHeight,
    ),
  };
}

function layEndCard(text: string, output: OutputSpec): Laid {
  const { maxWidth, text: style } = LOOK.endCard;
  const lines = wrapText(text, style, maxWidth);
  const height = (lines.length - 1) * lineHeight(style) + style.capHeight;
  const top = (output.height - height) / 2;
  const panel: Box = { x: 0, y: 0, width: output.width, height: output.height };
  return {
    panel,
    mask: textMask(lines, style, output.width / 2, top + style.capHeight),
  };
}
