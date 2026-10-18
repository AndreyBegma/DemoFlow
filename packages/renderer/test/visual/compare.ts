import type { Picture } from '../../src/ffmpeg/raster.ts';

/** How far a picture may stray from its baseline and still pass. */
export interface Tolerance {
  /** The largest per-channel difference (0–255) a pixel may have and not count as different. */
  pixel: number;
  /** The largest share (0–1) of pixels that may count as different. */
  share: number;
}

export interface Comparison {
  /** The largest per-channel difference anywhere in the picture. */
  maxDelta: number;
  /** The share of pixels whose largest channel difference exceeds `tolerance.pixel`. */
  share: number;
  /** The same pixels, as a count. */
  differing: number;
  ok: boolean;
  /** Present when the pictures differ; absent when their sizes differ. */
  diff?: Picture;
}

/** Compares `actual` with `expected`, pixel by pixel. */
export function comparePictures(
  actual: Picture,
  expected: Picture,
  tolerance: Tolerance,
): Comparison {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return { maxDelta: 255, share: 1, differing: 0, ok: false };
  }
  const total = actual.width * actual.height;
  const diff = {
    width: actual.width,
    height: actual.height,
    data: new Uint8Array(actual.data.length),
  };
  let maxDelta = 0;
  let differing = 0;
  for (let p = 0; p < total; p++) {
    const at = p * 3;
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      delta = Math.max(
        delta,
        Math.abs(actual.data[at + c] - expected.data[at + c]),
      );
    }
    maxDelta = Math.max(maxDelta, delta);
    // The baseline, dimmed, so a difference reads against what it replaced.
    const dim =
      (expected.data[at] + expected.data[at + 1] + expected.data[at + 2]) / 12;
    diff.data[at] = dim;
    diff.data[at + 1] = dim;
    diff.data[at + 2] = dim;
    if (delta > tolerance.pixel) {
      differing++;
      diff.data[at] = 255;
      diff.data[at + 1] = 0;
      diff.data[at + 2] = 0;
    }
  }
  const share = differing / total;
  return { maxDelta, share, differing, ok: share <= tolerance.share, diff };
}

/** A copy of the `width × height` region of `picture` at (`x`, `y`). */
export function cropPicture(
  picture: Picture,
  x: number,
  y: number,
  width: number,
  height: number,
): Picture {
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * picture.width + x) * 3;
    data.set(picture.data.subarray(from, from + width * 3), row * width * 3);
  }
  return { width, height, data };
}
