import { describe, expect, it } from 'vitest';
import { fillPath, type PathCommand } from '../../src/ffmpeg/outline.ts';
import type { Mask } from '../../src/ffmpeg/raster.ts';

/** A closed rectangle, counter-clockwise in `y` up unless `reverse`. */
function rectangle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  reverse = false,
): PathCommand[] {
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  if (reverse) corners.reverse();
  return [
    { type: 'M', ...corners[0] },
    ...corners.slice(1).map((c): PathCommand => ({ type: 'L', ...c })),
    { type: 'Z' },
  ];
}

/** Coverage of the pixel at output (`x`, `y`). */
function at(mask: Mask, x: number, y: number): number {
  const mx = x - mask.x;
  const my = y - mask.y;
  if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) return 0;
  return mask.alpha[my * mask.width + mx];
}

const area = (mask: Mask) => mask.alpha.reduce((sum, a) => sum + a, 0);

describe('fillPath', () => {
  it('covers each pixel by the area of it inside the outline', () => {
    // 4 × 2 units from x 0.5: whole pixels inside, halves on the left and
    // right (each 128/255, coverage being eight-bit).
    const mask = fillPath(rectangle(0, 0, 4, 2), 1, 0.5);
    expect(area(mask)).toBeCloseTo(6 + 4 * (128 / 255), 4);
    expect(at(mask, 0, -1)).toBeCloseTo(0.5, 2);
    expect(at(mask, 2, -1)).toBe(1);
    expect(at(mask, 4, -1)).toBeCloseTo(0.5, 2);
    expect(at(mask, 2, 0)).toBe(0);
  });

  it('fills by the non-zero rule, in either direction', () => {
    const outer = rectangle(0, 0, 10, 10);
    // Same direction: still covered once.
    expect(area(fillPath([...outer, ...rectangle(2, 2, 8, 8)], 1, 0))).toBe(
      100,
    );
    // Opposite direction: a hole.
    expect(
      area(fillPath([...outer, ...rectangle(2, 2, 8, 8, true)], 1, 0)),
    ).toBe(64);
    expect(area(fillPath(rectangle(0, 0, 10, 10, true), 1, 0))).toBe(100);
  });

  it('flattens curves closely', () => {
    // A circle of radius 20 from four quadratic quarter arcs, each split in
    // two: the area of a true circle within 0.5 %.
    const r = 20;
    const k = r * Math.tan(Math.PI / 8);
    const s = r * Math.SQRT1_2;
    const circle: PathCommand[] = [
      { type: 'M', x: r, y: 0 },
      { type: 'Q', x1: r, y1: k, x: s, y: s },
      { type: 'Q', x1: k, y1: r, x: 0, y: r },
      { type: 'Q', x1: -k, y1: r, x: -s, y: s },
      { type: 'Q', x1: -r, y1: k, x: -r, y: 0 },
      { type: 'Q', x1: -r, y1: -k, x: -s, y: -s },
      { type: 'Q', x1: -k, y1: -r, x: 0, y: -r },
      { type: 'Q', x1: k, y1: -r, x: s, y: -s },
      { type: 'Q', x1: r, y1: -k, x: r, y: 0 },
      { type: 'Z' },
    ];
    const mask = fillPath(circle, 1, 0);
    expect(Math.abs(area(mask) / (Math.PI * r * r) - 1)).toBeLessThan(0.005);
    expect(mask.width).toBe(40);
    expect(mask.height).toBe(40);
  });

  it('returns an empty mask for an empty outline', () => {
    expect(fillPath([], 1, 0).width).toBe(0);
  });
});
