import type { Mask } from './raster.ts';

/**
 * One command of a glyph outline, in font units with `y` up — the shape
 * opentype.js gives. TrueType outlines use `Q`, CFF outlines `C`.
 */
export type PathCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | {
      type: 'C';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { type: 'Z' };

/** How far a flattened curve may stray from the true one, in pixels. */
const TOLERANCE = 0.05;

/**
 * Fills an outline, anti-aliased, as a mask. A point (`x`, `y`) of the outline
 * lands on pixel coordinates (`dx + x × scale`, `−y × scale`): the mask's
 * origin is the glyph's origin on the baseline, `y` down.
 *
 * Coverage is the exact area of each pixel inside the outline, under the
 * non-zero winding rule: every edge adds its signed area to an accumulation
 * buffer and each row is summed left to right (Raph Levien's font-rs
 * algorithm). Curves are flattened to lines first.
 */
export function fillPath(
  commands: readonly PathCommand[],
  scale: number,
  dx: number,
): Mask {
  const lines = flatten(commands, scale, dx);
  if (lines.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0, alpha: new Float32Array(0) };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < lines.length; i += 2) {
    left = Math.min(left, lines[i]);
    right = Math.max(right, lines[i]);
    top = Math.min(top, lines[i + 1]);
    bottom = Math.max(bottom, lines[i + 1]);
  }
  const x = Math.floor(left);
  const y = Math.floor(top);
  const width = Math.max(1, Math.ceil(right) - x);
  const height = Math.max(1, Math.ceil(bottom) - y);
  // Two spare columns: an edge on the right border writes one past it.
  const stride = width + 2;
  const accumulation = new Float32Array(stride * height);
  for (let i = 0; i + 3 < lines.length; i += 4) {
    accumulate(
      accumulation,
      stride,
      height,
      lines[i] - x,
      lines[i + 1] - y,
      lines[i + 2] - x,
      lines[i + 3] - y,
    );
  }
  const alpha = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    let sum = 0;
    for (let column = 0; column < width; column++) {
      sum += accumulation[row * stride + column];
      // Eight-bit coverage, as a font rasteriser hands it out: a pixel the
      // outline covers is exactly 1, not 1 less a rounding error.
      alpha[row * width + column] =
        Math.round(Math.min(1, Math.abs(sum)) * 255) / 255;
    }
  }
  return { x, y, width, height, alpha };
}

/**
 * The outline as line segments in pixels, four numbers each (`x0 y0 x1 y1`),
 * every contour closed.
 */
function flatten(
  commands: readonly PathCommand[],
  scale: number,
  dx: number,
): number[] {
  const out: number[] = [];
  let startX = 0;
  let startY = 0;
  let penX = 0;
  let penY = 0;
  let open = false;
  const lineTo = (x: number, y: number) => {
    if (x !== penX || y !== penY) out.push(penX, penY, x, y);
    penX = x;
    penY = y;
  };
  const close = () => {
    if (open) lineTo(startX, startY);
    open = false;
  };
  const px = (x: number) => dx + x * scale;
  const py = (y: number) => -y * scale;
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        close();
        startX = penX = px(command.x);
        startY = penY = py(command.y);
        open = true;
        break;
      case 'L':
        lineTo(px(command.x), py(command.y));
        break;
      case 'Q': {
        const x0 = penX;
        const y0 = penY;
        const x1 = px(command.x1);
        const y1 = py(command.y1);
        const x2 = px(command.x);
        const y2 = py(command.y);
        // A quadratic's chord error with n pieces is |p0 − 2p1 + p2| / 4n².
        const bend = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
        const n = Math.max(1, Math.ceil(Math.sqrt(bend / (4 * TOLERANCE))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          lineTo(
            u * u * x0 + 2 * u * t * x1 + t * t * x2,
            u * u * y0 + 2 * u * t * y1 + t * t * y2,
          );
        }
        break;
      }
      case 'C': {
        const x0 = penX;
        const y0 = penY;
        const x1 = px(command.x1);
        const y1 = py(command.y1);
        const x2 = px(command.x2);
        const y2 = py(command.y2);
        const x3 = px(command.x);
        const y3 = py(command.y);
        // A cubic's chord error with n pieces is at most 3/4 · max|Δ²p| / n².
        const bend = Math.max(
          Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
          Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3),
        );
        const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * bend) / TOLERANCE)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          lineTo(
            u * u * u * x0 +
              3 * u * u * t * x1 +
              3 * u * t * t * x2 +
              t * t * t * x3,
            u * u * u * y0 +
              3 * u * u * t * y1 +
              3 * u * t * t * y2 +
              t * t * t * y3,
          );
        }
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  return out;
}

/**
 * Adds the signed area one edge sweeps to the cells it crosses, so that a
 * running sum along a row gives each pixel's winding coverage. Downward edges
 * add, upward edges subtract.
 */
function accumulate(
  buffer: Float32Array,
  stride: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  if (ay === by) return;
  let x0 = ax;
  let y0 = ay;
  let x1 = bx;
  let y1 = by;
  let direction = 1;
  if (y0 > y1) {
    direction = -1;
    [x0, y0, x1, y1] = [x1, y1, x0, y0];
  }
  const slope = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) {
    x -= y0 * slope;
    y0 = 0;
  }
  const last = Math.min(height, Math.ceil(y1));
  for (let row = Math.max(0, Math.floor(y0)); row < last; row++) {
    const base = row * stride;
    const dy = Math.min(row + 1, y1) - Math.max(row, y0);
    const next = x + slope * dy;
    const d = dy * direction;
    const lo = Math.min(x, next);
    const hi = Math.max(x, next);
    const loCell = Math.floor(lo);
    const hiCell = Math.ceil(hi);
    if (hiCell <= loCell + 1) {
      // The edge stays inside one column on this row.
      const share = (x + next) / 2 - loCell;
      buffer[base + loCell] += d - d * share;
      buffer[base + loCell + 1] += d * share;
    } else {
      const s = 1 / (hi - lo);
      const loFraction = lo - loCell;
      const first = 0.5 * s * (1 - loFraction) * (1 - loFraction);
      const hiFraction = hi - hiCell + 1;
      const end = 0.5 * s * hiFraction * hiFraction;
      buffer[base + loCell] += d * first;
      if (hiCell === loCell + 2) {
        buffer[base + loCell + 1] += d * (1 - first - end);
      } else {
        const second = s * (1.5 - loFraction);
        buffer[base + loCell + 1] += d * (second - first);
        for (let cell = loCell + 2; cell < hiCell - 1; cell++) {
          buffer[base + cell] += d * s;
        }
        const before = second + (hiCell - loCell - 3) * s;
        buffer[base + hiCell - 1] += d * (1 - before - end);
      }
      buffer[base + hiCell] += d * end;
    }
    x = next;
  }
}
