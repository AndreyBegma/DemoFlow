import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PathCommand } from './outline.ts';

/**
 * The part of opentype.js (2.0.0) the compositor calls, typed: the package
 * ships no types, and `@types/opentype.js` describes 1.x.
 */
export interface OpenTypeGlyph {
  advanceWidth?: number;
  path: { commands: PathCommand[] };
}

export interface OpenTypeFont {
  unitsPerEm: number;
  /** hhea descender: negative, in font units. */
  descender: number;
  tables: { os2: { sCapHeight: number } };
  glyphs: { get(index: number): OpenTypeGlyph };
  /** 0 when the font has no glyph for the character. */
  charToGlyphIndex(char: string): number;
  /** The GPOS (or `kern`) adjustment between two glyph indexes, in font units. */
  getKerningValue(left: number, right: number): number;
}

interface OpenType {
  parse(buffer: ArrayBuffer): OpenTypeFont;
}

// Loaded through `require`: the package's ES module build has no default
// export and Node does not pick up its UMD build's named exports.
const opentype: OpenType = createRequire(import.meta.url)('opentype.js');

export function loadFont(file: string): OpenTypeFont {
  const bytes = readFileSync(file);
  return opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}
