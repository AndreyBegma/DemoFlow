/**
 * The compositor's text: the Hershey Simplex stroke font, drawn by the
 * compositor itself. FFmpeg cannot draw text on every platform: the
 * `ffmpeg-static` build has no `drawtext` (FFmpeg ≥ 6.1 needs harfbuzz for it),
 * and `subtitles` needs system fonts. A system font cannot be relied on either.
 *
 * Provenance: the glyphs were drawn by Dr. A. V. Hershey at the U.S. National
 * Bureau of Standards (1967). The data is in the public domain. This table
 * comes from Paul Bourke's `simplex[95][112]` (October 1997,
 * https://paulbourke.net/dataformats/hershey/), re-encoded without changes.
 *
 * Limits: printable ASCII only (any other character is drawn as `?`), and a
 * single-stroke, technical look.
 */

/**
 * ASCII 32–126: `[advance, strokes]`. Each pair of characters in `strokes` is
 * one vertex, `x` then `y`, as character code − 82 (`R`). `" R"` lifts the pen.
 * Units: the cap height is 21, the baseline is `y` 0, and `y` points up.
 */
const GLYPHS: readonly (readonly [number, string])[] = [
  [16, ''],
  [10, 'WgWY RWTVSWRXSWT'],
  [16, 'VgV` R^g^`'],
  [21, ']kVK Rck\\K RV^d^ RUXcX'],
  [20, 'ZkZN R^k^N Rcdaf^gZgWfUdUbV`W_Y^_\\a[bZcXcUaS^RZRWSUU'],
  [24, 'ggUR RZg\\e\\c[aY`W`UbUdVfXgZg\\f_ebeefgg RcYaX`V`TbRdRfSgUgWeYcY'],
  [26, 'i^i_h`g`f_e]cXaU_S]RYRWSVTUVUXVZW[^__``b`d_f]g[fZdZb[_]\\bUdSfRhRiSiT'],
  [10, 'WeVfWgXfXdWbVa'],
  [14, ']k[iYfWbV]VYWTYP[M]K'],
  [14, 'UkWiYf[b\\]\\Y[TYPWMUK'],
  [16, 'ZgZ[ RUd_^ R_dU^'],
  [26, '_d_R RV[h['],
  [10, 'XSWRVSWTXSXQWOVN'],
  [26, 'V[h['],
  [10, 'WTVSWRXSWT'],
  [22, 'fkTK'],
  [20, '[gXfVcU^U[VVXS[R]R`SbVc[c^bc`f]g[g'],
  [20, 'XcZd]g]R'],
  [20, 'VbVcWeXfZg^g`faebcbaa__\\URcR'],
  [20, 'Wgbg\\___a^b]cZcXbU`S]RZRWSVTUV'],
  [20, '_gUYdY R_g_R'],
  [20, 'agWgV^W_Z`]``_b]cZcXbU`S]RZRWSVTUV'],
  [20, 'bdaf^g\\gYfWcV^VYWUYS\\R]R`SbUcXcYb\\`^]_\\_Y^W\\VY'],
  [20, 'cgYR RUgcg'],
  [20, 'ZgWfVdVbW`Y_]^`]b[cYcVbTaS^RZRWSVTUVUYV[X][^__a`bbbdaf^gZg'],
  [20, 'b`a]_[\\Z[ZX[V]U`UaVdXf[g\\g_fadb`b[aV_S\\RZRWSVU'],
  [10, 'W`V_W^X_W` RWTVSWRXSWT'],
  [10, 'W`V_W^X_W` RXSWRVSWTXSXQWOVN'],
  [24, 'fdV[fR'],
  [26, 'V^h^ RVXhX'],
  [24, 'Vdf[VR'],
  [18, 'UbUcVeWfYg]g_f`eacaa`__^[\\[Y R[TZS[R\\S[T'],
  [
    27,
    'd_caab^b\\a[`Z]ZZ[X]W`WbXcZ R^b\\`[][Z\\X]W RdbcZcXeWgWiYj\\j^iahcfedfag^g[fYeWcVaU^U[VXWVYT[S^RaRdSfTgU RebdZdXeW',
  ],
  [18, '[gSR R[gcR RVY`Y'],
  [21, 'VgVR RVg_gbfcedcdac_b^_] RV]_]b\\c[dYdVcTbS_RVR'],
  [21, 'dbcdaf_g[gYfWdVbU_UZVWWUYS[R_RaScUdW'],
  [21, 'VgVR RVg]g`fbdcbd_dZcWbU`S]RVR'],
  [19, 'VgVR RVgcg RV]^] RVRcR'],
  [18, 'VgVR RVgcg RV]^]'],
  [21, 'dbcdaf_g[gYfWdVbU_UZVWWUYS[R_RaScUdWdZ R_ZdZ'],
  [22, 'VgVR RdgdR RV]d]'],
  [8, 'VgVR'],
  [16, '^g^W]T\\SZRXRVSUTTWTY'],
  [21, 'VgVR RdgVY R[^dR'],
  [17, 'VgVR RVRbR'],
  [24, 'VgVR RVg^R Rfg^R RfgfR'],
  [22, 'VgVR RVgdR RdgdR'],
  [22, '[gYfWdVbU_UZVWWUYS[R_RaScUdWeZe_dbcdaf_g[g'],
  [21, 'VgVR RVg_gbfcedcd`c^b]_\\V\\'],
  [22, '[gYfWdVbU_UZVWWUYS[R_RaScUdWeZe_dbcdaf_g[g R^VdP'],
  [21, 'VgVR RVg_gbfcedcdac_b^_]V] R]]dR'],
  [20, 'cdaf^gZgWfUdUbV`W_Y^_\\a[bZcXcUaS^RZRWSUU'],
  [16, 'ZgZR RSgag'],
  [22, 'VgVXWUYS\\R^RaScUdXdg'],
  [18, 'Sg[R Rcg[R'],
  [24, 'TgYR R^gYR R^gcR RhgcR'],
  [20, 'UgcR RcgUR'],
  [18, 'Sg[][R Rcg[]'],
  [20, 'cgUR RUgcg RURcR'],
  [14, 'VkVK RWkWK RVk]k RVK]K'],
  [14, 'Rg`O'],
  [14, '[k[K R\\k\\K RUk\\k RUK\\K'],
  [16, 'XaZd\\a RU^Zc_^ RZcZR'],
  [16, 'RPbP'],
  [10, 'XgWfVdVbWaXbWc'],
  [19, 'a`aR Ra]__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [19, 'VgVR RV]X_Z`]`__a]bZbXaU_S]RZRXSVU'],
  [18, 'a]__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [19, 'agaR Ra]__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [18, 'UZaZa\\`^__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [12, '\\gZgXfWcWR RT`[`'],
  [19, 'a`aP`M_L]KZKXL Ra]__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [19, 'VgVR RV\\Y_[`^``_a\\aR'],
  [8, 'UgVfWgVhUg RV`VR'],
  [10, 'WgXfYgXhWg RX`XOWLUKSK'],
  [17, 'VgVR R``VV RZZaR'],
  [8, 'VgVR'],
  [30, 'V`VR RV\\Y_[`^``_a\\aR Ra\\d_f`i`k_l\\lR'],
  [19, 'V`VR RV\\Y_[`^``_a\\aR'],
  [19, 'Z`X_V]UZUXVUXSZR]R_SaUbXbZa]__]`Z`'],
  [19, 'V`VK RV]X_Z`]`__a]bZbXaU_S]RZRXSVU'],
  [19, 'a`aK Ra]__]`Z`X_V]UZUXVUXSZR]R_SaU'],
  [13, 'V`VR RVZW]Y_[`^`'],
  [17, '`]__\\`Y`V_U]V[XZ]Y_X`V`U_S\\RYRVSUU'],
  [12, 'WgWVXSZR\\R RT`[`'],
  [19, 'V`VVWSYR\\R^SaV Ra`aR'],
  [16, 'T`ZR R``ZR'],
  [22, 'U`YR R]`YR R]`aR Re`aR'],
  [17, 'U``R R``UR'],
  [16, 'T`ZR R``ZRXNVLTKSK'],
  [17, '``UR RU``` RUR`R'],
  [
    14,
    '[kYjXiWgWeXcYbZ`Z^X\\ RYjXhXfYdZc[a[_Z]V[ZY[W[UZSYRXPXNYL RXZZXZVYTXSWQWOXMYL[K',
  ],
  [8, 'VkVK'],
  [
    14,
    'WkYjZi[g[eZcYbX`X^Z\\ RYjZhZfYdXcWaW_X]\\[XYWWWUXSYRZPZNYL RZZXXXVYTZS[Q[OZMYLWK',
  ],
  [24, 'UXUZV]X^Z^\\]`ZbYdYfZg\\ RUZV\\X]Z]\\\\`YbXdXfYg\\g^'],
];

/** Font units from the baseline to the top of a capital. */
const CAP_UNITS = 21;
/** Font units below the baseline that a descender reaches. */
const DESCENT_UNITS = 7;

interface Glyph {
  advance: number;
  /** Polylines in font units. */
  strokes: { x: number; y: number }[][];
}

const decoded = GLYPHS.map(([advance, data]): Glyph => {
  const strokes: { x: number; y: number }[][] = [];
  let line: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (data[i] === ' ' && data[i + 1] === 'R') {
      if (line.length > 0) strokes.push(line);
      line = [];
    } else {
      line.push({ x: data.charCodeAt(i) - 82, y: data.charCodeAt(i + 1) - 82 });
    }
  }
  if (line.length > 0) strokes.push(line);
  return { advance, strokes };
});

function glyph(char: string): Glyph {
  const code = char.charCodeAt(0);
  return decoded[code >= 32 && code <= 126 ? code - 32 : 31];
}

/** A text style, in output pixels. */
export interface TextStyle {
  /** The CSS font size the look agreed on. */
  fontPx: number;
  /** Stroke width. */
  weight: number;
}

/** Cap height of a typical sans-serif, as a fraction of its font size. */
const CAP_RATIO = 0.72;

/** Height of a capital letter: what the look's font size draws. */
export function capHeight(style: TextStyle): number {
  return Math.round(style.fontPx * CAP_RATIO);
}

/**
 * Pixels per font unit. The stroke is centred on the glyph outline, so it
 * reaches half its weight beyond it: the outline is drawn that much smaller to
 * keep the inked capital at exactly `capHeight`.
 */
function unitOf(style: TextStyle): number {
  return (capHeight(style) - style.weight) / CAP_UNITS;
}

/** The width `text` takes on one line. */
export function measureText(text: string, style: TextStyle): number {
  const unit = unitOf(style);
  let units = 0;
  for (const char of text) units += glyph(char).advance;
  return units * unit;
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
  return unitOf(style) * DESCENT_UNITS + style.weight / 2;
}

/** A segment of a drawn stroke, in output pixels. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The strokes of `text` with its first baseline starting at (`x`, `y`). */
export function textSegments(
  text: string,
  style: TextStyle,
  x: number,
  y: number,
): Segment[] {
  const unit = unitOf(style);
  // The baseline is the bottom of the inked capital, not of its outline.
  const base = y - style.weight / 2;
  const segments: Segment[] = [];
  let pen = x;
  for (const char of text) {
    const { advance, strokes } = glyph(char);
    for (const line of strokes) {
      // A one-vertex stroke is a dot: a segment of length zero.
      for (let i = 0; i < Math.max(1, line.length - 1); i++) {
        const a = line[i];
        const b = line[Math.min(i + 1, line.length - 1)];
        segments.push({
          x1: pen + a.x * unit,
          y1: base - a.y * unit,
          x2: pen + b.x * unit,
          y2: base - b.y * unit,
        });
      }
    }
    pen += advance * unit;
  }
  return segments;
}
