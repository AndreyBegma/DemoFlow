import {
  BACKGROUND_PRESETS,
  type BackgroundConfig,
  CardsConfigSchema,
  type Navigation,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { createCompositor, renderStage } from '../../src/ffmpeg/compose.ts';
import { drawLayers } from '../../src/ffmpeg/layers.ts';
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
  files: [
    { format: 'mp4', codec: 'h264', pixelFormat: 'yuv420p', faststart: true },
  ],
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

/**
 * The page before a navigation, at the synthetic source's size (spec 114):
 * warm horizontal bands and a dark panel where the source has its white bar,
 * so a held frame and a dissolve read apart from the live page.
 */
export function previousPageSource(): Picture {
  const picture = createPicture(1280, 720);
  for (let y = 0; y < 720; y++) {
    for (let x = 0; x < 1280; x++) {
      let [r, g, b] = (y >> 5) % 2 === 0 ? [235, 200, 150] : [210, 160, 110];
      if (x >= 160 && x < 640 && y >= 80 && y < 240) [r, g, b] = [30, 40, 60];
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
  /** A held source time (spec 114): drawn from `previousPageSource()`. */
  heldSourceMs?: number;
  /** Drawn as the vertical output of `plan` (spec 176), at its size. */
  vertical?: true;
  /** Drawn as the square output of `plan` (spec 304), at its size. */
  square?: true;
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
export function framedPlan(
  options: RenderPlanOptions = {},
  extra: { navigations?: Navigation[]; sceneAtMs?: number } = {},
): RenderPlan {
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
      zoom: true,
    },
    { stepIndex: 2, action: 'wait', startMs: 1600, endMs: 3000 },
  ];
  if (extra.sceneAtMs !== undefined) {
    events.push({
      stepIndex: 3,
      action: 'marker',
      startMs: extra.sceneAtMs,
      endMs: extra.sceneAtMs,
      marker: { title: 'Invoices', kind: 'scene' },
    });
  }
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        videoFile: 'source.webm',
        events,
        ...(extra.navigations === undefined
          ? {}
          : { navigations: extra.navigations }),
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

/**
 * Spec 114: the click loads a new page 1 700–2 300 ms, a scene card at
 * 2 700. The masked field's mask is up when the navigation starts, so the
 * held frame carries it.
 */
const TRANSITIONED = framedPlan(
  {
    transitions: { enabled: true, durationMs: 300 },
    cards: CardsConfigSchema.parse({ intro: { enabled: false } }),
  },
  {
    navigations: [
      { startMs: 0, endMs: 50 },
      { startMs: 1700, endMs: 2300 },
    ],
    sceneAtMs: 2700,
  },
);
const HELD_SOURCE_MS = TRANSITIONED.transitions?.holds[1]?.sourceMs;

/** Spec 176: the framed run with the vertical output; the frame is not used there. */
const VERTICAL = framedPlan({ formats: ['mp4', 'mp4-vertical'] });
const VERTICAL_SIZE = { width: 1080, height: 1920 } as const;

/** Spec 304: the same run with the square output. */
const SQUARE = framedPlan({ formats: ['mp4', 'mp4-square'] });
const SQUARE_SIZE = { width: 1080, height: 1080 } as const;

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
  // Spec 114: the page before the load, held at 2 000 ms with its mask.
  transitioned('held-frame-mask', 2000),
  // Mid-dissolve, 2 466 ms: the held page into the loaded one.
  transitioned('fade-navigation', 2466.67),
  // A scene card 166 ms into its dissolve from the page.
  transitioned('fade-card', 2866.67),
  // Spec 146: the first frame of the loaded page alone, 2 600 ms. The masked
  // field's box is gone with the page it was on.
  transitioned('live-after-navigation', 2600),
  {
    // Spec 176: the crop on the red block at the press, zoomed, with the
    // cursor, the ring and a caption long enough to need a third line.
    name: 'vertical-zoomed',
    frame: {
      ...frameAt(VERTICAL, PRESS_FRAME, 'vertical'),
      caption:
        'Open the invoice, check the total and the due date, then send it to the customer — Создать клиента',
    },
    region: { x: 0, y: 0, ...VERTICAL_SIZE },
    plan: VERTICAL,
    vertical: true,
  },
  {
    // At the start: the crop on the page centre, the field's mask in it.
    name: 'vertical-follow',
    frame: frameAt(VERTICAL, 0, 'vertical'),
    region: { x: 0, y: 0, ...VERTICAL_SIZE },
    plan: VERTICAL,
    vertical: true,
  },
  {
    // A card centred in the vertical frame, wrapped to its width.
    name: 'vertical-card',
    frame: state({
      sourceMs: null,
      content: { x: 0, y: 0, ...VERTICAL_SIZE },
      card: {
        title: 'Create a customer',
        subtitle: 'From the dashboard to a saved record',
        background: BACKGROUND_PRESET_COLOURS.ocean,
      },
    }),
    region: { x: 0, y: 0, ...VERTICAL_SIZE },
    plan: VERTICAL,
    vertical: true,
  },
  {
    // Spec 304: the square crop on the red block at the press, zoomed, with
    // the cursor, the ring and a caption long enough to need a third line.
    name: 'square-zoomed',
    frame: {
      ...frameAt(SQUARE, PRESS_FRAME, 'square'),
      caption:
        'Open the invoice, check the total and the due date, then send it to the customer — Создать клиента',
    },
    region: { x: 0, y: 0, ...SQUARE_SIZE },
    plan: SQUARE,
    square: true,
  },
];

function transitioned(name: string, atMs: number): Scene {
  return {
    name,
    frame: frameAt(TRANSITIONED, Math.round((atMs * 30) / 1000)),
    region: { x: 0, y: 0, width: 1920, height: 1080 },
    plan: TRANSITIONED,
    ...(HELD_SOURCE_MS === undefined ? {} : { heldSourceMs: HELD_SOURCE_MS }),
  };
}

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

const PREVIOUS_PAGE = previousPageSource();

/** Draws `scene` and returns the region it keeps. */
export function renderScene(scene: Scene, source: Picture): Picture {
  const crop =
    scene.vertical === true
      ? scene.plan?.vertical
      : scene.square === true
        ? scene.plan?.square
        : undefined;
  const output =
    crop === undefined
      ? OUTPUT
      : { ...OUTPUT, width: crop.width, height: crop.height };
  const target = createPicture(output.width, output.height);
  const compositor =
    crop === undefined
      ? createCompositor(
          output,
          scene.plan === undefined ? undefined : renderStage(scene.plan),
        )
      : createCompositor(output, undefined, crop.caption);
  drawLayers(compositor, target, scene.frame, (ms) =>
    ms === scene.heldSourceMs ? PREVIOUS_PAGE : source,
  );
  const { x, y, width, height } = scene.region;
  return cropPicture(target, x, y, width, height);
}
