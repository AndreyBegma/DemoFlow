/**
 * The compositor's text: Inter, bundled in `fonts/` (SIL OFL 1.1, subset to
 * Latin, Latin-1, Cyrillic and common punctuation — see `fonts/README.md`),
 * rasterised by the compositor itself. FFmpeg cannot draw text on every
 * platform: the `ffmpeg-static` build has no `drawtext` (FFmpeg ≥ 6.1 needs
 * harfbuzz for it), and `subtitles` needs system fonts. A system font cannot
 * be relied on either.
 *
 * Outlines are read with opentype.js and filled by `outline.ts`. Each glyph is
 * rasterised once per size and quarter-pixel position, then reused. Any
 * character outside the subset is drawn as `?`.
 */

import { fileURLToPath } from 'node:url';
import { loadFont, type OpenTypeFont } from './opentype.ts';
import { fillPath } from './outline.ts';
import type { Mask } from './raster.ts';

export type FontWeight = 'regular' | 'semibold';

/** A text style, in output pixels. */
export interface TextStyle {
  /** The CSS font size the look agreed on. */
  fontPx: number;
  weight: FontWeight;
}

const FILES: Record<FontWeight, string> = {
  regular: 'Inter-Regular.ttf',
  semibold: 'Inter-SemiBold.ttf',
};

interface Face {
  font: OpenTypeFont;
  /** Font units from the baseline to the flat top of a capital. */
  capUnits: number;
  /** Font units a descender reaches below the baseline. */
  descentUnits: number;
  /** The glyph drawn for a character the font does not have. */
  fallback: number;
}

const faces = new Map<FontWeight, Face>();

function face(weight: FontWeight): Face {
  let loaded = faces.get(weight);
  if (loaded === undefined) {
    // `fonts/` sits two levels above this file in `src/ffmpeg/` and `dist/ffmpeg/` alike.
    const font = loadFont(
      fileURLToPath(new URL(`../../fonts/${FILES[weight]}`, import.meta.url)),
    );
    loaded = {
      font,
      capUnits: font.tables.os2.sCapHeight,
      descentUnits: -font.descender,
      fallback: font.charToGlyphIndex('?'),
    };
    faces.set(weight, loaded);
  }
  return loaded;
}

/** Cap height of a typical sans-serif, as a fraction of its font size. */
const CAP_RATIO = 0.72;

/** Height of a capital letter: what the look's font size draws. */
export function capHeight(style: TextStyle): number {
  return Math.round(style.fontPx * CAP_RATIO);
}

/**
 * Pixels per font unit. Inter's own cap height is 0.727 of its size; the scale
 * puts the flat top of a capital exactly `capHeight` above the baseline.
 */
function unitOf(style: TextStyle): number {
  return capHeight(style) / face(style.weight).capUnits;
}

/** The glyphs of `text` and where each starts, in font units from its start. */
function shape(
  text: string,
  weight: FontWeight,
): { glyph: number; at: number }[] {
  const { font, fallback } = face(weight);
  const shaped: { glyph: number; at: number }[] = [];
  let pen = 0;
  let previous = -1;
  for (const char of text) {
    const index = font.charToGlyphIndex(char);
    const glyph = index === 0 ? fallback : index;
    if (previous >= 0) pen += font.getKerningValue(previous, glyph);
    shaped.push({ glyph, at: pen });
    pen += font.glyphs.get(glyph).advanceWidth ?? 0;
    previous = glyph;
  }
  shaped.push({ glyph: -1, at: pen });
  return shaped;
}

/** The width `text` takes on one line. */
export function measureText(text: string, style: TextStyle): number {
  const shaped = shape(text, style.weight);
  return shaped[shaped.length - 1].at * unitOf(style);
}

/** Breaks `text` into lines no wider than `maxWidth`, at spaces where it can. */
export function wrapText(
  text: string,
  style: TextStyle,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measureText(candidate, style) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      // A word wider than a line is broken where it overflows.
      line = '';
      for (const char of word) {
        if (line !== '' && measureText(line + char, style) > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The distance from one baseline to the next. */
export function lineHeight(style: TextStyle): number {
  return style.fontPx * 1.25;
}

/** How far a descender reaches below the baseline. */
export function descent(style: TextStyle): number {
  return unitOf(style) * face(style.weight).descentUnits;
}

/** Positions per pixel a glyph is rasterised at, horizontally. */
const PHASES = 4;

/** Rasterised glyphs, by weight, scale, glyph and horizontal phase. */
const bitmaps = new Map<string, Mask>();

function bitmap(
  weight: FontWeight,
  unit: number,
  glyph: number,
  phase: number,
): Mask {
  const key = `${weight}/${unit}/${glyph}/${phase}`;
  let mask = bitmaps.get(key);
  if (mask === undefined) {
    const { commands } = face(weight).font.glyphs.get(glyph).path;
    mask = fillPath(commands, unit, phase / PHASES);
    bitmaps.set(key, mask);
  }
  return mask;
}

/** A glyph's bitmap and where its origin goes, in whole output pixels. */
export interface PlacedGlyph {
  mask: Mask;
  x: number;
  y: number;
}

/**
 * The glyphs of `text` with its baseline starting at (`x`, `y`). The baseline
 * is snapped to a whole pixel, so a capital's flat top and bottom are sharp.
 */
export function textGlyphs(
  text: string,
  style: TextStyle,
  x: number,
  y: number,
): PlacedGlyph[] {
  const unit = unitOf(style);
  const baseline = Math.round(y);
  const placed: PlacedGlyph[] = [];
  for (const { glyph, at } of shape(text, style.weight)) {
    if (glyph < 0) break;
    const steps = Math.round((x + at * unit) * PHASES);
    const whole = Math.floor(steps / PHASES);
    const mask = bitmap(style.weight, unit, glyph, steps - whole * PHASES);
    if (mask.width > 0) placed.push({ mask, x: whole, y: baseline });
  }
  return placed;
}
