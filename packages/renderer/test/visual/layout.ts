/**
 * Structural checks on a decoded output frame (RGB24): where the page is, not
 * what it looks like. A frame is a pass/fail on the #47 signature: the page in
 * a quarter of the frame and the recorder's padding grey everywhere else.
 */

/** The grey Chromium's recorder pads a video with when the page does not fill it. */
export const PADDING_GREY = { r: 127, g: 125, b: 129, tolerance: 6 } as const;

/** A quadrant counts as page content when its luminance spans at least this much. */
export const MIN_QUADRANT_RANGE = 24;

/** The largest connected padding-grey region allowed, as a share of the frame. */
export const MAX_PADDING_SHARE = 0.1;

/** The side, in pixels, of the cells the padding search works in. */
const CELL = 40;

export interface LayoutReport {
  /** The luminance range (max − min) of each quadrant: top-left, top-right, bottom-left, bottom-right. */
  quadrantRanges: number[];
  /** The largest 4-connected region of padding-grey cells, as a share of the frame. */
  paddingShare: number;
  /** What is wrong, one line each; empty when the layout is as expected. */
  problems: string[];
}

function isPaddingGrey(frame: Uint8Array, at: number): boolean {
  const { r, g, b, tolerance } = PADDING_GREY;
  return (
    Math.abs(frame[at] - r) <= tolerance &&
    Math.abs(frame[at + 1] - g) <= tolerance &&
    Math.abs(frame[at + 2] - b) <= tolerance
  );
}

function luminanceRange(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let low = 255;
  let high = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 3;
      const luma =
        0.2126 * frame[at] + 0.7152 * frame[at + 1] + 0.0722 * frame[at + 2];
      low = Math.min(low, luma);
      high = Math.max(high, luma);
    }
  }
  return Math.round(high - low);
}

/** The largest share of the frame one connected block of padding grey covers. */
function paddingShare(
  frame: Uint8Array,
  width: number,
  height: number,
): number {
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const grey = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let count = 0;
      let total = 0;
      for (let y = row * CELL; y < Math.min(height, (row + 1) * CELL); y++) {
        for (
          let x = column * CELL;
          x < Math.min(width, (column + 1) * CELL);
          x++
        ) {
          total++;
          if (isPaddingGrey(frame, (y * width + x) * 3)) count++;
        }
      }
      grey[row * columns + column] = count / total >= 0.9 ? 1 : 0;
    }
  }
  let largest = 0;
  const seen = new Uint8Array(grey.length);
  for (let start = 0; start < grey.length; start++) {
    if (!grey[start] || seen[start]) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      size++;
      const column = cell % columns;
      const neighbours = [
        column > 0 ? cell - 1 : -1,
        column < columns - 1 ? cell + 1 : -1,
        cell - columns,
        cell + columns,
      ];
      for (const next of neighbours) {
        if (next >= 0 && next < grey.length && grey[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return largest / grey.length;
}

/** The mean difference per channel allowed between the frame's margin and the stage it should show: H.264 noise, not a page. */
export const MAX_BACKGROUND_DELTA = 6;

export interface FramedLayoutReport extends LayoutReport {
  /** The mean absolute difference per channel between the frame and the stage outside the window. */
  backgroundDelta: number;
}

/**
 * The layout of a framed frame at zoom 1 (spec 100): `checkLayout` inside
 * `window` — page content in each of its quadrants, no block of padding — and
 * outside it, the stage (the background with the shadow) as drawn.
 */
export function checkFramedLayout(
  frame: Uint8Array,
  width: number,
  height: number,
  window: { x: number; y: number; width: number; height: number },
  stage: Uint8Array,
): FramedLayoutReport {
  // Whole pixels inside the window, and a 2 px band around it left out of either check.
  const x0 = Math.ceil(window.x);
  const y0 = Math.ceil(window.y);
  const x1 = Math.floor(window.x + window.width);
  const y1 = Math.floor(window.y + window.height);
  const inner = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
  for (let y = y0; y < y1; y++) {
    const from = (y * width + x0) * 3;
    inner.set(
      frame.subarray(from, from + (x1 - x0) * 3),
      (y - y0) * (x1 - x0) * 3,
    );
  }
  const report = checkLayout(inner, x1 - x0, y1 - y0);

  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= x0 - 2 && x < x1 + 2 && y >= y0 - 2 && y < y1 + 2) continue;
      const at = (y * width + x) * 3;
      for (let c = 0; c < 3; c++)
        total += Math.abs(frame[at + c] - stage[at + c]);
      count += 3;
    }
  }
  const backgroundDelta = count === 0 ? 0 : total / count;
  const problems = report.problems.map(
    (problem) => `in the window: ${problem}`,
  );
  if (count === 0) {
    problems.push('the window leaves no background on the frame');
  } else if (backgroundDelta > MAX_BACKGROUND_DELTA) {
    problems.push(
      `outside the window the frame is not the background (mean difference ${backgroundDelta.toFixed(1)}, max ${MAX_BACKGROUND_DELTA})`,
    );
  }
  return { ...report, problems, backgroundDelta };
}

/** Checks that `frame` shows page content in every quadrant and no large block of padding. */
export function checkLayout(
  frame: Uint8Array,
  width: number,
  height: number,
): LayoutReport {
  const midX = width >> 1;
  const midY = height >> 1;
  const quadrantRanges = [
    luminanceRange(frame, width, 0, 0, midX, midY),
    luminanceRange(frame, width, midX, 0, width, midY),
    luminanceRange(frame, width, 0, midY, midX, height),
    luminanceRange(frame, width, midX, midY, width, height),
  ];
  const share = paddingShare(frame, width, height);
  const problems: string[] = [];
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  quadrantRanges.forEach((range, i) => {
    if (range < MIN_QUADRANT_RANGE) {
      problems.push(
        `the ${names[i]} quadrant is uniform (luminance range ${range})`,
      );
    }
  });
  if (share > MAX_PADDING_SHARE) {
    problems.push(
      `padding grey covers ${(share * 100).toFixed(1)} % of the frame in one block (max ${MAX_PADDING_SHARE * 100} %)`,
    );
  }
  return { quadrantRanges, paddingShare: share, problems };
}
