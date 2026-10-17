import type { Box } from '@demoflow/core';

/** An RGB24 picture: `width × height × 3` bytes, rows top to bottom. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Colour {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` → a colour. */
export function hex(value: string): Colour {
  const n = Number.parseInt(value.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function createPicture(width: number, height: number): Picture {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

export function fill(picture: Picture, colour: Colour): void {
  const { data } = picture;
  for (let i = 0; i < data.length; i += 3) {
    data[i] = colour.r;
    data[i + 1] = colour.g;
    data[i + 2] = colour.b;
  }
}

/** Mixes `colour` into pixel `index` (a byte offset) with `alpha` 0–1. */
function blendAt(
  data: Uint8Array,
  index: number,
  colour: Colour,
  alpha: number,
): void {
  const keep = 1 - alpha;
  data[index] = data[index] * keep + colour.r * alpha;
  data[index + 1] = data[index + 1] * keep + colour.g * alpha;
  data[index + 2] = data[index + 2] * keep + colour.b * alpha;
}

/** A box's whole pixels inside the picture: `[x0, y0, x1, y1)`. */
function pixelBounds(
  picture: Picture,
  box: Box,
): [number, number, number, number] {
  return [
    Math.max(0, Math.round(box.x)),
    Math.max(0, Math.round(box.y)),
    Math.min(picture.width, Math.round(box.x + box.width)),
    Math.min(picture.height, Math.round(box.y + box.height)),
  ];
}

/** Draws the `crop` of `source` scaled into `content` of `target`, bilinear. */
export function drawScaled(
  target: Picture,
  source: Picture,
  crop: Box,
  content: Box,
): void {
  const [x0, y0, x1, y1] = pixelBounds(target, content);
  const columns = samples(
    x0,
    x1,
    content.x,
    crop.x,
    crop.width / content.width,
    source.width,
  );
  const rows = samples(
    y0,
    y1,
    content.y,
    crop.y,
    crop.height / content.height,
    source.height,
  );
  const src = source.data;
  const dst = target.data;
  const stride = source.width * 3;
  for (let y = y0; y < y1; y++) {
    const top = rows.from[y - y0] * stride;
    const bottom = rows.to[y - y0] * stride;
    const fy = rows.weight[y - y0];
    let out = (y * target.width + x0) * 3;
    for (let x = 0; x < x1 - x0; x++) {
      const left = columns.from[x] * 3;
      const right = columns.to[x] * 3;
      const fx = columns.weight[x];
      for (let c = 0; c < 3; c++) {
        const a = src[top + left + c];
        const b = src[top + right + c];
        const d = src[bottom + left + c];
        const e = src[bottom + right + c];
        const upper = a + (b - a) * fx;
        const lower = d + (e - d) * fx;
        dst[out + c] = upper + (lower - upper) * fy + 0.5;
      }
      out += 3;
    }
  }
}

/** For each output pixel `[start, end)`, the two source pixels it mixes and the weight of the second. */
function samples(
  start: number,
  end: number,
  contentStart: number,
  cropStart: number,
  step: number,
  size: number,
): { from: Int32Array; to: Int32Array; weight: Float32Array } {
  const count = Math.max(0, end - start);
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const weight = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const at = Math.min(
      size - 1,
      Math.max(0, cropStart + (start + i + 0.5 - contentStart) * step - 0.5),
    );
    from[i] = Math.floor(at);
    to[i] = Math.min(size - 1, from[i] + 1);
    weight[i] = at - from[i];
  }
  return { from, to, weight };
}

/** Covers `box` with `colour` at `alpha`. */
export function fillBox(
  picture: Picture,
  box: Box,
  colour: Colour,
  alpha: number,
): void {
  const [x0, y0, x1, y1] = pixelBounds(picture, box);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      blendAt(picture.data, (y * picture.width + x) * 3, colour, alpha);
    }
  }
}

/**
 * Blurs the inside of `box` like a Gaussian of `sigma` pixels: three box
 * blurs (Kutskir's widths), reading pixels around the box so its edge does
 * not show the source sharp.
 */
export function blurBox(picture: Picture, box: Box, sigma: number): void {
  const [bx0, by0, bx1, by1] = pixelBounds(picture, box);
  if (bx1 <= bx0 || by1 <= by0) return;
  const margin = Math.ceil(sigma * 3);
  const x0 = Math.max(0, bx0 - margin);
  const y0 = Math.max(0, by0 - margin);
  const x1 = Math.min(picture.width, bx1 + margin);
  const y1 = Math.min(picture.height, by1 + margin);
  const width = x1 - x0;
  const height = y1 - y0;
  const channels: Float32Array[] = [0, 1, 2].map((c) => {
    const plane = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        plane[y * width + x] =
          picture.data[((y + y0) * picture.width + x + x0) * 3 + c];
      }
    }
    return plane;
  });
  const scratch = new Float32Array(width * height);
  for (const size of gaussBoxes(sigma, 3)) {
    const radius = (size - 1) / 2;
    for (const plane of channels) {
      boxPass(plane, scratch, width, height, radius, true);
      boxPass(scratch, plane, width, height, radius, false);
    }
  }
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const at = (y - y0) * width + (x - x0);
      const index = (y * picture.width + x) * 3;
      for (let c = 0; c < 3; c++) picture.data[index + c] = channels[c][at];
    }
  }
}

/** Box widths whose `n` passes approximate a Gaussian of `sigma`. */
function gaussBoxes(sigma: number, n: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) /
      (-4 * lower - 4),
  );
  return Array.from({ length: n }, (_, i) => (i < m ? lower : upper));
}

/** One box blur along rows (`horizontal`) or columns, edges clamped. */
function boxPass(
  from: Float32Array,
  to: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 1 : width;
  const scale = 1 / (2 * radius + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    const at = (i: number): number =>
      from[base + Math.min(length - 1, Math.max(0, i)) * step];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += at(i);
    for (let i = 0; i < length; i++) {
      to[base + i * step] = sum * scale;
      sum += at(i + radius + 1) - at(i - radius);
    }
  }
}

/**
 * Paints `colour` where `coverage(x, y)` — at the pixel's centre, 0–1 — says,
 * times `alpha`, over the pixels of `bounds`.
 */
export function paint(
  picture: Picture,
  bounds: Box,
  colour: Colour,
  alpha: number,
  coverage: (x: number, y: number) => number,
): void {
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const x1 = Math.min(picture.width, Math.ceil(bounds.x + bounds.width));
  const y1 = Math.min(picture.height, Math.ceil(bounds.y + bounds.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const amount = coverage(x + 0.5, y + 0.5) * alpha;
      if (amount > 0) {
        blendAt(picture.data, (y * picture.width + x) * 3, colour, amount);
      }
    }
  }
}

/** Coverage of a pixel whose centre is `distance` inside an edge (negative: outside). */
export function edge(distance: number): number {
  return Math.min(1, Math.max(0, distance + 0.5));
}

/** Signed distance to a rounded rectangle: negative inside. */
export function roundRectDistance(
  box: Box,
  radius: number,
  x: number,
  y: number,
): number {
  const hx = box.width / 2 - radius;
  const hy = box.height / 2 - radius;
  const dx = Math.abs(x - (box.x + box.width / 2)) - hx;
  const dy = Math.abs(y - (box.y + box.height / 2)) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a closed polygon: negative inside. */
export function polygonDistance(
  points: readonly { x: number; y: number }[],
  x: number,
  y: number,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    nearest = Math.min(nearest, segmentDistance(a.x, a.y, b.x, b.y, x, y));
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside ? -nearest : nearest;
}

function segmentDistance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
  y: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / length));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** An alpha mask placed at (`x`, `y`) of a picture. */
export interface Mask {
  x: number;
  y: number;
  width: number;
  height: number;
  alpha: Float32Array;
}

/**
 * Masks moved by whole pixels and merged into one. Where two overlap, their
 * coverage adds up to at most 1: two glyphs' anti-aliased edges that touch
 * fill the pixel they share.
 */
export function mergeMasks(
  parts: readonly { mask: Mask; x: number; y: number }[],
): Mask {
  if (parts.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0, alpha: new Float32Array(0) };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { mask, x, y } of parts) {
    left = Math.min(left, mask.x + x);
    top = Math.min(top, mask.y + y);
    right = Math.max(right, mask.x + x + mask.width);
    bottom = Math.max(bottom, mask.y + y + mask.height);
  }
  const width = right - left;
  const alpha = new Float32Array(width * (bottom - top));
  for (const { mask, x, y } of parts) {
    const ox = mask.x + x - left;
    const oy = mask.y + y - top;
    for (let my = 0; my < mask.height; my++) {
      const row = (oy + my) * width + ox;
      for (let mx = 0; mx < mask.width; mx++) {
        const amount = mask.alpha[my * mask.width + mx];
        if (amount > 0) alpha[row + mx] = Math.min(1, alpha[row + mx] + amount);
      }
    }
  }
  return { x: left, y: top, width, height: bottom - top, alpha };
}

/** Paints `colour` through `mask`, moved by (`dx`, `dy`). */
export function paintMask(
  picture: Picture,
  mask: Mask,
  colour: Colour,
  dx = 0,
  dy = 0,
): void {
  const ox = mask.x + Math.round(dx);
  const oy = mask.y + Math.round(dy);
  for (let my = 0; my < mask.height; my++) {
    const y = oy + my;
    if (y < 0 || y >= picture.height) continue;
    for (let mx = 0; mx < mask.width; mx++) {
      const x = ox + mx;
      if (x < 0 || x >= picture.width) continue;
      const amount = mask.alpha[my * mask.width + mx];
      if (amount > 0) {
        blendAt(picture.data, (y * picture.width + x) * 3, colour, amount);
      }
    }
  }
}
