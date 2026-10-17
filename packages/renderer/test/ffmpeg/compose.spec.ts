import { describe, expect, it } from 'vitest';
import { createCompositor, LOOK } from '../../src/ffmpeg/compose.ts';
import {
  capHeight,
  lineHeight,
  measureText,
  wrapText,
} from '../../src/ffmpeg/font.ts';
import { sourceFrameIndex } from '../../src/ffmpeg/pipeline.ts';
import {
  createPicture,
  drawScaled,
  type Picture,
} from '../../src/ffmpeg/raster.ts';
import type { FrameState, OutputSpec } from '../../src/index.ts';

const OUTPUT: OutputSpec = {
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  pixelFormat: 'yuv420p',
  faststart: true,
};

/** A 1280×720 source of 4 px black and white squares: blur greys it. */
function checkerboard(): Picture {
  const picture = createPicture(1280, 720);
  for (let y = 0; y < 720; y++) {
    for (let x = 0; x < 1280; x++) {
      const value = ((x >> 2) + (y >> 2)) % 2 === 0 ? 0 : 255;
      picture.data.fill(value, (y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3);
    }
  }
  return picture;
}

function state(overrides: Partial<FrameState> = {}): FrameState {
  return {
    sourceMs: 0,
    crop: { x: 0, y: 0, width: 1280, height: 720 },
    content: { x: 0, y: 0, width: 1920, height: 1080 },
    scale: 1.5,
    rings: [],
    masks: [],
    watermark: false,
    ...overrides,
  };
}

function render(frame: FrameState, source?: Picture): Picture {
  const target = createPicture(OUTPUT.width, OUTPUT.height);
  createCompositor(OUTPUT).compose(target, frame, source);
  return target;
}

function pixel(picture: Picture, x: number, y: number): number[] {
  const at = (Math.round(y) * picture.width + Math.round(x)) * 3;
  return [...picture.data.subarray(at, at + 3)];
}

/** How many pixels of `box` differ between two pictures. */
function changed(
  a: Picture,
  b: Picture,
  box: { x: number; y: number; width: number; height: number },
): number {
  let count = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const at = (y * a.width + x) * 3;
      if (
        a.data[at] !== b.data[at] ||
        a.data[at + 1] !== b.data[at + 1] ||
        a.data[at + 2] !== b.data[at + 2]
      ) {
        count++;
      }
    }
  }
  return count;
}

const SOURCE = checkerboard();
const PLAIN = render(state(), SOURCE);

describe('drawScaled', () => {
  it('maps the crop onto the content box', () => {
    const source = createPicture(2, 1);
    source.data.set([255, 0, 0, 0, 0, 255]);
    const target = createPicture(8, 4);
    drawScaled(
      target,
      source,
      { x: 0, y: 0, width: 2, height: 1 },
      { x: 2, y: 1, width: 4, height: 2 },
    );
    // Outside the content box: untouched.
    expect(pixel(target, 0, 0)).toEqual([0, 0, 0]);
    expect(pixel(target, 7, 3)).toEqual([0, 0, 0]);
    // Left edge red, right edge blue, the middle mixed.
    expect(pixel(target, 2, 1)).toEqual([255, 0, 0]);
    expect(pixel(target, 5, 2)).toEqual([0, 0, 255]);
    const middle = pixel(target, 3, 1);
    expect(middle[0]).toBeGreaterThan(0);
    expect(middle[2]).toBeGreaterThan(0);
  });

  it('shows a zoomed crop', () => {
    const zoomed = render(
      state({ crop: { x: 640, y: 360, width: 640, height: 360 } }),
      SOURCE,
    );
    // Source (640, 360) is a black square's corner; at 3× it fills output (0..12).
    expect(pixel(zoomed, 4, 4)).toEqual([0, 0, 0]);
    expect(pixel(zoomed, 16, 4)).toEqual([255, 255, 255]);
  });
});

describe('the compositor', () => {
  it('draws the source and nothing else on a plain frame', () => {
    expect(pixel(PLAIN, 3, 3)).toEqual([0, 0, 0]);
    expect(pixel(PLAIN, 9, 3)).toEqual([255, 255, 255]);
  });

  it('blurs and washes a mask, inside its box only', () => {
    const box = { x: 400, y: 300, width: 300, height: 60 };
    const masked = render(state({ masks: [box] }), SOURCE);
    expect(changed(masked, PLAIN, box)).toBe(box.width * box.height);
    // The checkerboard becomes an even grey, near the wash over mid-grey.
    for (const [x, y] of [
      [450, 320],
      [600, 340],
    ]) {
      for (const channel of pixel(masked, x, y)) {
        expect(channel).toBeGreaterThan(110);
        expect(channel).toBeLessThan(150);
      }
    }
    const around = { x: 380, y: 280, width: 340, height: 100 };
    expect(changed(masked, PLAIN, around)).toBe(box.width * box.height);
  });

  it('draws the cursor with its tip at the point, sized by scale', () => {
    const cursor = { x: 1000, y: 500 };
    const drawn = render(state({ cursor }), SOURCE);
    // Inside the arrow: white; just left of its left edge: the dark outline.
    expect(pixel(drawn, 1000 + 3 * 1.5, 500 + 12 * 1.5)).toEqual([
      255, 255, 255,
    ]);
    const outline = pixel(drawn, 1000 - 1.5, 500 + 12 * 1.5);
    expect(Math.max(...outline)).toBeLessThan(40);
    // 28 px tall at scale 1, so ~42 px at 1.5: nothing drawn beyond.
    const bounds = { x: 990, y: 490, width: 50, height: 60 };
    expect(changed(drawn, PLAIN, bounds)).toBeGreaterThan(0);
    expect(
      changed(drawn, PLAIN, { x: 960, y: 560, width: 100, height: 40 }),
    ).toBe(0);
  });

  it('draws a ring growing from 12 to 36 px and fading', () => {
    const point = { x: 960, y: 540 };
    const start = render(state({ rings: [{ point, progress: 0 }] }), SOURCE);
    // On the circle (radius 12 × 1.5): white; at the centre: the source.
    expect(pixel(start, 960 + 18, 540)).toEqual([255, 255, 255]);
    expect(pixel(start, 960, 540)).toEqual(pixel(PLAIN, 960, 540));
    const late = render(state({ rings: [{ point, progress: 0.5 }] }), SOURCE);
    // Radius 24 × 1.5 = 36, at opacity 0.5.
    const onRing = pixel(late, 960 + 36, 540);
    const under = pixel(PLAIN, 960 + 36, 540);
    expect(onRing[0]).toBeCloseTo((under[0] + 255) / 2, -1);
  });

  it('draws the caption as a lower third, 64 px above the bottom', () => {
    const drawn = render(state({ caption: 'Customers, at a glance' }), SOURCE);
    const panelHeight =
      capHeight(LOOK.caption.text) * (1 + 7 / 21) + 2 * LOOK.caption.padding;
    const bottom = OUTPUT.height - LOOK.caption.bottom;
    // Above the panel and below it: untouched.
    expect(
      changed(drawn, PLAIN, { x: 0, y: 0, width: 1920, height: 900 }),
    ).toBe(0);
    expect(
      changed(drawn, PLAIN, { x: 0, y: bottom + 1, width: 1920, height: 63 }),
    ).toBe(0);
    // Inside the panel: the source darkened to 40 %.
    const y = Math.round(bottom - 4);
    expect(pixel(drawn, 960, y)[0]).toBeLessThanOrEqual(103);
    expect(Math.round(bottom - panelHeight)).toBeGreaterThan(900);
  });

  it('draws the watermark in the top-right corner', () => {
    const drawn = render(state({ watermark: true }), SOURCE);
    const [r, g, b] = pixel(drawn, 1920 - 24 - 6, 24 + 32);
    expect([r, g, b]).toEqual([0xd9, 0x30, 0x25]);
    expect(pixel(drawn, 1920 - 10, 10)).toEqual(pixel(PLAIN, 1920 - 10, 10));
  });

  it('draws the end card instead of the source, with the watermark over it', () => {
    const drawn = render(
      state({
        sourceMs: null,
        endCard: 'Verification failed at step 3: expected 4 rows',
        watermark: true,
      }),
    );
    expect(pixel(drawn, 100, 100)).toEqual([0x11, 0x11, 0x11]);
    let white = 0;
    for (let x = 0; x < 1920; x++) {
      for (let y = 500; y < 580; y++) {
        if (pixel(drawn, x, y)[0] === 255) white++;
      }
    }
    expect(white).toBeGreaterThan(500);
    expect(pixel(drawn, 1920 - 24 - 6, 24 + 32)).toEqual([0xd9, 0x30, 0x25]);
  });
});

/**
 * The vertical extent of the pixels in `box` that `isInk` accepts: the height
 * of a line of capitals, measured from the picture rather than from the layout.
 */
function inkHeight(
  picture: Picture,
  box: { x: number; y: number; width: number; height: number },
  isInk: (rgb: number[]) => boolean,
): number {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let y = Math.floor(box.y); y < box.y + box.height; y++) {
    for (let x = Math.floor(box.x); x < box.x + box.width; x++) {
      if (isInk(pixel(picture, x, y))) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return bottom - top + 1;
}

const isWhite = ([r, g, b]: number[]) => r > 200 && g > 200 && b > 200;

describe('text size', () => {
  it('draws the FAILED label with a cap height of 23 px (32 × 0.72)', () => {
    const drawn = render(state({ sourceMs: null, watermark: true }));
    const style = LOOK.watermark.text;
    const width = measureText(LOOK.watermark.label, style);
    const box = {
      x: OUTPUT.width - LOOK.watermark.margin - width - LOOK.watermark.paddingX,
      y: LOOK.watermark.margin,
      width: width + 2 * LOOK.watermark.paddingX,
      height: capHeight(style) + 2 * LOOK.watermark.paddingY,
    };
    expect(Math.abs(inkHeight(drawn, box, isWhite) - 23)).toBeLessThanOrEqual(
      1,
    );
  });

  it('draws a caption with a cap height of 29 px (40 × 0.72)', () => {
    const plain = render(state({ sourceMs: null }));
    const drawn = render(state({ sourceMs: null, caption: 'HEH' }));
    const box = { x: 800, y: 900, width: 320, height: 116 };
    expect(changed(drawn, plain, box)).toBeGreaterThan(0);
    expect(Math.abs(inkHeight(drawn, box, isWhite) - 29)).toBeLessThanOrEqual(
      1,
    );
  });

  it('draws the end card first line with a cap height of 35 px (48 × 0.72)', () => {
    const drawn = render(
      state({ sourceMs: null, endCard: 'HEH', watermark: false }),
    );
    const box = { x: 700, y: 400, width: 520, height: 280 };
    expect(Math.abs(inkHeight(drawn, box, isWhite) - 35)).toBeLessThanOrEqual(
      1,
    );
  });

  it('spaces lines at 1.25 × the font size', () => {
    expect(lineHeight(LOOK.endCard.text)).toBe(60);
    expect(lineHeight(LOOK.caption.text)).toBe(50);
  });
});

describe('the stroke font', () => {
  const style = { fontPx: 40, weight: 4 };

  it('measures by advance and draws non-ASCII as "?"', () => {
    expect(measureText('', style)).toBe(0);
    expect(measureText('é', style)).toBe(measureText('?', style));
    expect(measureText('ab', style)).toBeCloseTo(
      measureText('a', style) + measureText('b', style),
    );
  });

  it('wraps at spaces and breaks a word wider than the line', () => {
    const lines = wrapText('one two three four five', style, 250);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureText(line, style)).toBeLessThanOrEqual(250);
    }
    expect(lines.join(' ')).toBe('one two three four five');
    const long = wrapText('x'.repeat(100), style, 300);
    expect(long.join('')).toBe('x'.repeat(100));
    expect(long.length).toBeGreaterThan(1);
  });
});

describe('sourceFrameIndex', () => {
  const source = {
    file: 'source.webm',
    width: 1280,
    height: 720,
    fps: 25,
    durationMs: 4000,
    scale: 1,
  };

  it('is the frame on screen at the time', () => {
    expect(sourceFrameIndex(0, source)).toBe(0);
    expect(sourceFrameIndex(39.9, source)).toBe(0);
    expect(sourceFrameIndex(40, source)).toBe(1);
    expect(sourceFrameIndex(1000, source)).toBe(25);
    expect(sourceFrameIndex(-100, source)).toBe(0);
  });
});
