import { createCompositor } from '../../src/ffmpeg/compose.ts';
import { createPicture, type Picture } from '../../src/ffmpeg/raster.ts';
import type { FrameState, OutputSpec } from '../../src/index.ts';
import { cropPicture } from './compare.ts';

export const OUTPUT: OutputSpec = {
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  pixelFormat: 'yuv420p',
  faststart: true,
};

/**
 * A 1280×720 stand-in for a recorded page, built from integer arithmetic only:
 * a diagonal gradient, a grid, solid blocks and fine stripes, so scaling, blur
 * and the overlays all have something to show against.
 */
export function syntheticSource(): Picture {
  const picture = createPicture(1280, 720);
  for (let y = 0; y < 720; y++) {
    for (let x = 0; x < 1280; x++) {
      let r = 40 + ((x + y) >> 4);
      let g = 70 + (x >> 3);
      let b = 110 + (y >> 3);
      if (x % 64 === 0 || y % 64 === 0) [r, g, b] = [230, 230, 235];
      if (x >= 200 && x < 520 && y >= 120 && y < 180)
        [r, g, b] = [250, 250, 250];
      if (x >= 700 && x < 900 && y >= 300 && y < 420) [r, g, b] = [200, 60, 50];
      if (x >= 300 && x < 600 && y >= 450 && y < 600 && (x >> 1) % 2 === 0) {
        [r, g, b] = [20, 20, 20];
      }
      const at = (y * 1280 + x) * 3;
      picture.data[at] = r;
      picture.data[at + 1] = g;
      picture.data[at + 2] = b;
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

/** One baseline: a fixed state, and the region of the output frame it keeps. */
export interface Scene {
  name: string;
  frame: FrameState;
  region: { x: number; y: number; width: number; height: number };
}

export const SCENES: readonly Scene[] = [
  {
    name: 'cursor',
    frame: state({ cursor: { x: 1000, y: 500 } }),
    region: { x: 960, y: 460, width: 120, height: 120 },
  },
  {
    name: 'click-rings',
    frame: state({
      rings: [
        { point: { x: 700, y: 400 }, progress: 0 },
        { point: { x: 860, y: 400 }, progress: 0.5 },
        { point: { x: 1020, y: 400 }, progress: 0.9 },
      ],
    }),
    region: { x: 620, y: 330, width: 480, height: 140 },
  },
  {
    name: 'caption',
    frame: state({ caption: 'Customers, at a glance — Создать клиента' }),
    region: { x: 360, y: 880, width: 1200, height: 140 },
  },
  {
    name: 'mask',
    frame: state({ masks: [{ x: 1050, y: 450, width: 300, height: 180 }] }),
    region: { x: 1000, y: 400, width: 400, height: 280 },
  },
  {
    name: 'zoomed-frame',
    frame: state({
      crop: { x: 320, y: 180, width: 640, height: 360 },
      cursor: { x: 700, y: 540 },
      scale: 3,
    }),
    region: { x: 360, y: 240, width: 720, height: 480 },
  },
  {
    name: 'failure-card',
    frame: state({
      sourceMs: null,
      endCard: 'Verification failed at step 3: expected 4 rows, found 3',
      watermark: true,
    }),
    region: { x: 0, y: 0, width: 1920, height: 1080 },
  },
];

/** Draws `scene` and returns the region it keeps. */
export function renderScene(scene: Scene, source: Picture): Picture {
  const target = createPicture(OUTPUT.width, OUTPUT.height);
  createCompositor(OUTPUT).compose(
    target,
    scene.frame,
    scene.frame.endCard === undefined ? source : undefined,
  );
  const { x, y, width, height } = scene.region;
  return cropPicture(target, x, y, width, height);
}
