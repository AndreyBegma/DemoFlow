import {
  BACKGROUND_PRESETS,
  type BackgroundConfig,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { createCompositor, renderStage } from '../../src/ffmpeg/compose.ts';
import { createPicture, type Picture } from '../../src/ffmpeg/raster.ts';
import {
  BACKGROUND_PRESET_COLOURS,
  type FrameState,
  frameAt,
  type OutputSpec,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
} from '../../src/index.ts';
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
  /** The framed plan `frame` comes from: the compositor draws its stage. */
  plan?: RenderPlan;
}

const PASSED_STAGES: Stages = {
  readiness: { status: 'passed' },
  execution: { status: 'passed' },
  verification: { status: 'passed' },
  recording: { status: 'passed' },
  rendering: { status: 'pending' },
  storage: { status: 'pending' },
};

const RESULT: RunResult = {
  schemaVersion: 1,
  runId: 'baseline',
  scenarioId: 'baseline',
  scenarioName: 'baseline',
  startedAt: '2026-10-18T10:00:00.000Z',
  finishedAt: '2026-10-18T10:00:03.000Z',
  status: 'completed',
  stages: PASSED_STAGES,
  renders: [],
  warnings: [],
};

/**
 * A run over the synthetic source, planned with the frame on: the white bar
 * is a masked field, then the red block is clicked — the camera zooms on it.
 */
export function framedPlan(options: RenderPlanOptions = {}): RenderPlan {
  const events: TimelineEvent[] = [
    {
      stepIndex: 0,
      action: 'fill',
      startMs: 0,
      endMs: 600,
      target: { box: { x: 200, y: 120, width: 320, height: 60 } },
      masked: true,
      value: '***',
    },
    {
      stepIndex: 1,
      action: 'click',
      startMs: 600,
      endMs: 1600,
      target: { box: { x: 700, y: 300, width: 200, height: 120 } },
      pointer: { from: { x: 640, y: 560 }, to: { x: 800, y: 360 } },
    },
    { stepIndex: 2, action: 'wait', startMs: 1600, endMs: 3000 },
  ];
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        videoFile: 'source.webm',
        events,
      },
      result: RESULT,
      source: {
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 4000,
        codec: 'vp9',
        freezes: [],
      },
    },
    { offsetMs: 0, frame: {}, ...options },
  );
}

const FRAMED = framedPlan();
/** The press of the click: the camera is at its 1.25× zoom on the red block. */
const PRESS_FRAME = Math.round((FRAMED.clicks[0].atMs * 30) / 1000);

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
    name: 'key-badge',
    frame: state({
      key: { text: 'Enter', anchor: { x: 960, y: 430 } },
      cursor: { x: 900, y: 400 },
    }),
    region: { x: 760, y: 360, width: 400, height: 160 },
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
  {
    // Spec 100: the default look at zoom 1 — the window on the ocean preset.
    name: 'framed-window',
    frame: frameAt(FRAMED, 0),
    region: { x: 0, y: 0, width: 1920, height: 1080 },
    plan: FRAMED,
  },
  {
    // Zoomed on the click: the window, the mask, the cursor and the ring move together.
    name: 'framed-zoomed',
    frame: frameAt(FRAMED, PRESS_FRAME),
    region: { x: 0, y: 0, width: 1920, height: 1080 },
    plan: FRAMED,
  },
  // Spec 108: cards on the background, in the caption's typeface.
  card(
    'card-intro',
    'Create a customer',
    'From the dashboard to a saved record',
  ),
  card('card-intro-no-description', 'Create a customer'),
  card('card-scene', 'Invoices'),
  card('card-outro', 'Acme', 'acme.dev/try'),
  card('card-outro-no-cta', 'Acme'),
  card(
    'card-long-title',
    // The title runs past two lines and ends in an ellipsis; the subtitle just fills two.
    'A scenario name long enough to need a second line, and then so many more words that even two lines of it cannot hold them all',
    'And a description that is long enough to wrap onto a second line of its own, and still goes on and on past that second line too',
  ),
  card('card-light-background', 'Acme', 'acme.dev/try', 'paper'),
];

function card(
  name: string,
  title: string,
  subtitle?: string,
  preset: keyof typeof BACKGROUND_PRESET_COLOURS = 'ocean',
): Scene {
  return {
    name,
    frame: state({
      sourceMs: null,
      card: {
        title,
        ...(subtitle === undefined ? {} : { subtitle }),
        background: BACKGROUND_PRESET_COLOURS[preset],
      },
    }),
    region: { x: 0, y: 0, width: 1920, height: 1080 },
  };
}

/** Every background a config can name: the six presets, a colour and a custom gradient. */
export const SWATCH_BACKGROUNDS: readonly BackgroundConfig[] = [
  ...BACKGROUND_PRESETS.map((preset) => ({ preset })),
  { color: '#3b3b98' },
  { gradient: { from: '#ffd166', to: '#06d6a0', angle: 90 } },
];

const SWATCH = { width: 480, height: 270, columns: 4 } as const;

/** Each background in `SWATCH_BACKGROUNDS` framing the page at zoom 1, 480×270, four to a row. */
export function renderSwatches(source: Picture): Picture {
  const rows = Math.ceil(SWATCH_BACKGROUNDS.length / SWATCH.columns);
  const strip = createPicture(
    SWATCH.width * SWATCH.columns,
    SWATCH.height * rows,
  );
  SWATCH_BACKGROUNDS.forEach((background, i) => {
    const plan = framedPlan({
      background,
      output: { width: SWATCH.width, height: SWATCH.height },
    });
    const swatch = createPicture(SWATCH.width, SWATCH.height);
    createCompositor(plan.output, renderStage(plan)).compose(
      swatch,
      frameAt(plan, 0),
      source,
    );
    const left = (i % SWATCH.columns) * SWATCH.width;
    const top = Math.floor(i / SWATCH.columns) * SWATCH.height;
    for (let y = 0; y < SWATCH.height; y++) {
      const from = y * SWATCH.width * 3;
      strip.data.set(
        swatch.data.subarray(from, from + SWATCH.width * 3),
        ((top + y) * strip.width + left) * 3,
      );
    }
  });
  return strip;
}

/** Draws `scene` and returns the region it keeps. */
export function renderScene(scene: Scene, source: Picture): Picture {
  const target = createPicture(OUTPUT.width, OUTPUT.height);
  const stage = scene.plan === undefined ? undefined : renderStage(scene.plan);
  createCompositor(OUTPUT, stage).compose(
    target,
    scene.frame,
    scene.frame.endCard === undefined ? source : undefined,
  );
  const { x, y, width, height } = scene.region;
  return cropPicture(target, x, y, width, height);
}
