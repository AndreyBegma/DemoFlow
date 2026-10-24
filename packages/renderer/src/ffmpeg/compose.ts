import type { Box } from '@demoflow/core';
import type {
  CropSpec,
  FrameState,
  OutputSpec,
  RenderPlan,
} from '../plan/types.ts';
import {
  capHeight,
  clampLines,
  descent,
  lineHeight,
  measureText,
  type TextStyle,
  textGlyphs,
  wrapText,
} from './font.ts';
import {
  blurBox,
  type Colour,
  createPicture,
  drawScaled,
  drawScaledRounded,
  edge,
  fill,
  fillBox,
  fillGradient,
  hex,
  type Mask,
  mergeMasks,
  type Picture,
  paint,
  paintMask,
  polygonDistance,
  roundRectDistance,
} from './raster.ts';

const WHITE = hex('#ffffff');
const BLACK = hex('#000000');

/**
 * The look both renderers share (agreed for spec 4): output pixels, times the
 * frame's `scale` for the cursor and the rings. Text sizes are CSS font sizes;
 * the compositor draws a cap height of `round(fontPx × 0.72)`.
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
    text: { fontPx: 40, weight: 'regular' },
  },
  /** Hangs below the target, in the caption's panel and type. */
  key: {
    gap: 12,
    paddingX: 14,
    paddingY: 8,
    text: { fontPx: 28, weight: 'semibold' },
  },
  watermark: {
    fill: hex('#d93025'),
    margin: 24,
    paddingX: 16,
    paddingY: 8,
    radius: 12,
    label: 'FAILED',
    text: { fontPx: 32, weight: 'semibold' },
  },
  endCard: {
    background: hex('#111111'),
    maxWidth: 1600,
    text: { fontPx: 48, weight: 'regular' },
  },
  /** Intro, scene and outro cards (spec 108), centred on the background. */
  card: {
    maxWidth: 1600,
    maxLines: 2,
    title: { fontPx: 64, weight: 'semibold' },
    subtitle: { fontPx: 40, weight: 'regular' },
    /** From the title's last baseline to the subtitle's first cap top. */
    gap: 44,
    text: WHITE,
    /** On a light background, such as `paper`. */
    textOnLight: hex('#111111'),
  },
  /** Under the window (spec 100), in output pixels at 1080p, scaled with the output height. */
  shadow: { colour: BLACK, alpha: 0.4, offsetY: 14, sigma: 28 },
  /** The 9:16 output (spec 176): text keeps this far from the frame's sides. */
  vertical: { marginX: 72 },
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

/**
 * The stage of a framed plan (spec 100): the background with the window's
 * shadow on it, drawn once — the camera then shows part of it on each frame.
 * `undefined` when the frame is off.
 */
export function renderStage(plan: RenderPlan): Picture | undefined {
  const { frame, output, fit, viewport } = plan;
  if (frame === undefined) return undefined;
  const stage = createPicture(output.width, output.height);
  const { background } = frame;
  fillGradient(
    stage,
    hex(background.from),
    hex(background.to),
    background.angle,
  );
  if (frame.shadow) {
    const unit = output.height / 1080;
    const { colour, alpha, offsetY, sigma } = LOOK.shadow;
    const spread = sigma * unit;
    const window: Box = {
      x: fit.x,
      y: fit.y + offsetY * unit,
      width: viewport.width * fit.scale,
      height: viewport.height * fit.scale,
    };
    const radius = Math.min(frame.radius, window.width / 2, window.height / 2);
    const reach = 3 * spread;
    paint(
      stage,
      {
        x: window.x - reach,
        y: window.y - reach,
        width: window.width + 2 * reach,
        height: window.height + 2 * reach,
      },
      colour,
      alpha,
      // A logistic edge: close to a Gaussian blur of the window's shape.
      (x, y) =>
        1 /
        (1 +
          Math.exp((1.7 * roundRectDistance(window, radius, x, y)) / spread)),
    );
  }
  return stage;
}

/**
 * `stage` is the plan's `renderStage`: frames whose state carries `frame`
 * draw the page in the window on it; without it the page fills the frame on
 * black, as before spec 100. `band` makes it the vertical output's (spec
 * 176): captions sit in that band, and cards and the end card wrap to the
 * frame's narrower width.
 */
export function createCompositor(
  output: OutputSpec,
  stage?: Picture,
  band?: CropSpec['caption'],
): Compositor {
  const captions = new Map<string, Laid>();
  const cards = new Map<string, Laid>();
  const titleCards = new Map<string, Laid>();
  const backdrops = new Map<string, Picture>();
  const badge = layBadge(output);
  // The landscape keeps its fixed text widths; the vertical frame is narrower.
  const narrow =
    band === undefined ? undefined : output.width - 2 * LOOK.vertical.marginX;
  const layCaptionHere =
    band === undefined
      ? (text: string) => layCaption(text, output)
      : (text: string) => layBandCaption(text, output, band);
  const screen: Box = {
    x: 0,
    y: 0,
    width: output.width,
    height: output.height,
  };

  return {
    compose(target, state, source) {
      const background = state.card?.background ?? state.backdrop;
      if (background !== undefined) {
        const key = `${background.from}${background.to}${background.angle}`;
        let backdrop = backdrops.get(key);
        if (backdrop === undefined) {
          backdrop = createPicture(output.width, output.height);
          fillGradient(
            backdrop,
            hex(background.from),
            hex(background.to),
            background.angle,
          );
          backdrops.set(key, backdrop);
        }
        target.data.set(backdrop.data);
        if (state.card !== undefined) {
          const { title, subtitle } = state.card;
          const laid = cached(titleCards, `${title}\n\n${subtitle ?? ''}`, () =>
            layCard(title, subtitle, output, narrow ?? LOOK.card.maxWidth),
          );
          const { text, textOnLight } = LOOK.card;
          paintMask(
            target,
            laid.mask,
            isLight(background) ? textOnLight : text,
          );
        }
      } else if (state.endCard !== undefined) {
        fill(target, LOOK.endCard.background);
        const card = cached(cards, state.endCard, (text) =>
          layEndCard(text, output, narrow ?? LOOK.endCard.maxWidth),
        );
        paintMask(target, card.mask, WHITE);
      } else {
        if (state.frame !== undefined) {
          if (stage === undefined) {
            throw new Error(
              'a framed frame needs the stage: renderStage(plan)',
            );
          }
          const { view, radius } = state.frame;
          if (sameBox(view, screen)) {
            target.data.set(stage.data);
          } else {
            drawScaled(target, stage, view, screen);
          }
          if (source !== undefined) {
            drawScaledRounded(
              target,
              source,
              state.crop,
              state.content,
              radius,
            );
          }
        } else {
          fill(target, BLACK);
          if (source !== undefined) {
            drawScaled(target, source, state.crop, state.content);
          }
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
          const caption = cached(captions, state.caption, layCaptionHere);
          const { panel } = LOOK.caption;
          drawPanel(target, caption.panel, panel, LOOK.caption.panelAlpha);
          paintMask(target, caption.mask, WHITE);
        }
        if (state.key !== undefined) {
          // Inside the part of the window on the frame.
          const laid = layKey(
            state.key.text,
            state.key.anchor,
            intersect(state.content, screen),
          );
          drawPanel(
            target,
            laid.panel,
            LOOK.caption.panel,
            LOOK.caption.panelAlpha,
          );
          paintMask(target, laid.mask, WHITE);
        }
      }
      if (state.watermark) {
        drawPanel(target, badge.panel, LOOK.watermark.fill, 1);
        paintMask(target, badge.mask, WHITE);
      }
    },
  };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** The overlap of two boxes; `a` itself when they do not overlap, so a badge still has somewhere to go. */
function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : a;
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
  const glyphs = lines.flatMap((line, index) =>
    textGlyphs(
      line,
      style,
      centreX - measureText(line, style) / 2,
      baseline + index * lineHeight(style),
    ),
  );
  return mergeMasks(glyphs);
}

/** The height of `lines` from the first cap top to the last descender. */
function blockHeight(lines: readonly string[], style: TextStyle): number {
  return (
    (lines.length - 1) * lineHeight(style) + capHeight(style) + descent(style)
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
      panel.y + padding + capHeight(style),
    ),
  };
}

/**
 * A vertical caption (spec 176, Decision 4): in the caption's panel, its type
 * at the band's size, wrapped to the frame less its margins and cut to the
 * band's lines, centred in the band.
 */
function layBandCaption(
  text: string,
  output: OutputSpec,
  band: CropSpec['caption'],
): Laid {
  const { padding } = LOOK.caption;
  const style: TextStyle = {
    ...LOOK.caption.text,
    fontPx: band.fontPx,
  };
  const lines = clampLines(
    text,
    style,
    output.width - 2 * LOOK.vertical.marginX - 2 * padding,
    band.maxLines,
  );
  const width =
    Math.max(...lines.map((line) => measureText(line, style))) + 2 * padding;
  const height = blockHeight(lines, style) + 2 * padding;
  const panel: Box = {
    x: (output.width - width) / 2,
    y: Math.round(band.top + (band.height - height) / 2),
    width,
    height,
  };
  return {
    panel,
    mask: textMask(
      lines,
      style,
      output.width / 2,
      panel.y + padding + capHeight(style),
    ),
  };
}

/** The key badge, centred under `anchor` and kept inside `content`. */
function layKey(
  text: string,
  anchor: { x: number; y: number },
  content: Box,
): Laid {
  const { gap, paddingX, paddingY, text: style } = LOOK.key;
  const width = measureText(text, style) + 2 * paddingX;
  const height = capHeight(style) + 2 * paddingY;
  const inside = (value: number, low: number, size: number, span: number) =>
    Math.round(Math.min(low + span - size, Math.max(low, value)));
  const panel: Box = {
    x: inside(anchor.x - width / 2, content.x, width, content.width),
    y: inside(anchor.y + gap, content.y, height, content.height),
    width,
    height,
  };
  return {
    panel,
    mask: textMask(
      [text],
      style,
      panel.x + width / 2,
      panel.y + paddingY + capHeight(style),
    ),
  };
}

function layBadge(output: OutputSpec): Laid {
  const { margin, paddingX, paddingY, label, text: style } = LOOK.watermark;
  const width = measureText(label, style) + 2 * paddingX;
  const height = capHeight(style) + 2 * paddingY;
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
      panel.y + paddingY + capHeight(style),
    ),
  };
}

/** The title and subtitle, each at most two lines, centred as one block. */
function layCard(
  title: string,
  subtitle: string | undefined,
  output: OutputSpec,
  maxWidth: number,
): Laid {
  const { maxLines, gap, title: big, subtitle: small } = LOOK.card;
  const titleLines = clampLines(title, big, maxWidth, maxLines);
  const subtitleLines =
    subtitle === undefined
      ? []
      : clampLines(subtitle, small, maxWidth, maxLines);
  const titleHeight =
    (titleLines.length - 1) * lineHeight(big) + capHeight(big);
  const subtitleHeight =
    subtitleLines.length === 0
      ? 0
      : gap + (subtitleLines.length - 1) * lineHeight(small) + capHeight(small);
  const top = Math.round((output.height - titleHeight - subtitleHeight) / 2);
  const panel: Box = { x: 0, y: 0, width: output.width, height: output.height };
  const centreX = output.width / 2;
  const titleMask = textMask(titleLines, big, centreX, top + capHeight(big));
  if (subtitleLines.length === 0) return { panel, mask: titleMask };
  const subtitleMask = textMask(
    subtitleLines,
    small,
    centreX,
    top + titleHeight + gap + capHeight(small),
  );
  return {
    panel,
    mask: mergeMasks([
      { mask: titleMask, x: 0, y: 0 },
      { mask: subtitleMask, x: 0, y: 0 },
    ]),
  };
}

/** Whether dark text reads better than white on `background`: its mean luminance is high. */
function isLight(background: { from: string; to: string }): boolean {
  const luminance = (value: string): number => {
    const { r, g, b } = hex(value);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  return (luminance(background.from) + luminance(background.to)) / 2 > 0.6;
}

function layEndCard(text: string, output: OutputSpec, maxWidth: number): Laid {
  const { text: style } = LOOK.endCard;
  const lines = wrapText(text, style, maxWidth);
  const height = (lines.length - 1) * lineHeight(style) + capHeight(style);
  const top = (output.height - height) / 2;
  const panel: Box = { x: 0, y: 0, width: output.width, height: output.height };
  return {
    panel,
    mask: textMask(lines, style, output.width / 2, top + capHeight(style)),
  };
}
