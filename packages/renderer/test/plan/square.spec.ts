import {
  type Annotation,
  CardsConfigSchema,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  cropViewAt,
  frameAt,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
  renderPath,
  SQUARE,
} from '../../src/index.ts';

/** Spec 304: the 1:1 crop that follows each step's target. */

const VIEWPORT = { width: 1920, height: 1080 };
/** The crop at zoom 1: the viewport's height, 1:1. */
const CROP = { width: 1080, height: 1080 };

const STAGES: Stages = {
  readiness: { status: 'passed' },
  execution: { status: 'passed' },
  verification: { status: 'passed' },
  recording: { status: 'passed' },
  rendering: { status: 'pending' },
  storage: { status: 'pending' },
};

const RESULT: RunResult = {
  schemaVersion: 1,
  runId: 'run',
  scenarioId: 'inline',
  scenarioName: 'inline',
  startedAt: '2026-10-24T10:00:00.000Z',
  finishedAt: '2026-10-24T10:00:10.000Z',
  status: 'completed',
  stages: STAGES,
  renders: [],
  warnings: [],
};

function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  options: RenderPlanOptions & { annotations?: Annotation[] } = {},
): RenderPlan {
  const { annotations, ...rest } = options;
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        videoFile: 'source.webm',
        events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
        ...(annotations === undefined ? {} : { annotations }),
      },
      result: RESULT,
      source: {
        width: 1920,
        height: 1080,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes: [],
      },
    },
    {
      offsetMs: 0,
      frame: { enabled: false },
      formats: ['mp4', 'mp4-vertical', 'mp4-square'],
      ...rest,
    },
  );
}

/** A click on a 120×28 target centred on `x`, from `startMs` for a second. */
function click(
  startMs: number,
  x: number,
  extra: Partial<TimelineEvent> = {},
): Omit<TimelineEvent, 'stepIndex'> {
  return {
    action: 'click',
    startMs,
    endMs: startMs + 1000,
    target: { box: { x: x - 60, y: 526, width: 120, height: 28 } },
    pointer: { from: { x: 960, y: 540 }, to: { x, y: 540 } },
    ...extra,
  };
}

function view(rendered: RenderPlan, atMs: number) {
  const { square } = rendered;
  if (square === undefined) throw new Error('no square output planned');
  return cropViewAt(rendered, square, atMs);
}

function centreX(rendered: RenderPlan, atMs: number): number {
  const box = view(rendered, atMs);
  return box.x + box.width / 2;
}

describe('the square output (spec 304)', () => {
  it('is planned only when a *-square format is asked for, at 1080×1080', () => {
    expect(plan([], { formats: ['mp4'] }).square).toBeUndefined();
    expect(plan([], { formats: ['mp4-vertical'] }).square).toBeUndefined();
    const rendered = plan([], { formats: ['mp4-square'] });
    expect(rendered.output.files).toEqual([
      {
        format: 'mp4-square',
        codec: 'h264',
        pixelFormat: 'yuv420p',
        faststart: true,
      },
    ]);
    expect(rendered.square).toMatchObject({ width: 1080, height: 1080 });
    expect(rendered.vertical).toBeUndefined();
  });

  it('plans the square WebM and GIF from the same square output', () => {
    const rendered = plan([], { formats: ['gif-square', 'webm-square'] });
    expect(rendered.output.files).toEqual([
      { format: 'gif-square', width: 600, height: 600, fps: 12 },
      {
        format: 'webm-square',
        codec: 'vp9',
        pixelFormat: 'yuv420p',
        crf: 32,
        cpuUsed: 4,
      },
    ]);
    expect(rendered.square).toMatchObject({ width: 1080, height: 1080 });
  });

  it('sizes the square GIF at three quarters of gif.width a side', () => {
    const rendered = plan([], {
      formats: ['gif-square'],
      gif: { width: 640 },
    });
    expect(rendered.output.files).toEqual([
      { format: 'gif-square', width: 480, height: 480, fps: 12 },
    ]);
  });

  it('names the files <renderer>.square.mp4, .webm and .gif', () => {
    for (const [format, extension] of [
      ['mp4-square', 'mp4'],
      ['webm-square', 'webm'],
      ['gif-square', 'gif'],
    ] as const) {
      expect(renderPath('run', 'ffmpeg', format)).toMatch(
        new RegExp(`render[/\\\\]ffmpeg\\.square\\.${extension}$`),
      );
    }
  });

  it('plans the vertical and the square outputs side by side', () => {
    const rendered = plan([], { formats: ['mp4-vertical', 'mp4-square'] });
    expect(rendered.vertical).toMatchObject({ width: 1080, height: 1920 });
    expect(rendered.square).toMatchObject({ width: 1080, height: 1080 });
  });

  it('crops the full page height at 1:1, starting on the page centre', () => {
    expect(view(plan([]), 0)).toEqual({
      x: 960 - CROP.width / 2,
      y: 0,
      width: CROP.width,
      height: CROP.height,
    });
  });

  it.each([
    ['left', 700],
    ['right', 1300],
  ])('follows a target on the %s, arriving as the step starts', (_, x) => {
    const rendered = plan([click(2000, x)]);
    expect(centreX(rendered, 1500)).toBe(960);
    expect(centreX(rendered, 2000)).toBeCloseTo(x, 6);
    expect(centreX(rendered, 5000)).toBeCloseTo(x, 6);
  });

  it('comes back to a target in the centre', () => {
    const rendered = plan([click(2000, 700), click(4000, 960)]);
    expect(centreX(rendered, 3000)).toBeCloseTo(700, 6);
    expect(centreX(rendered, 4000)).toBeCloseTo(960, 6);
    expect(centreX(plan([click(2000, 960)]), 3000)).toBe(960);
  });

  it.each([
    ['left', 20, 0],
    ['right', 1900, VIEWPORT.width - CROP.width],
  ])('clamps at the %s edge of the page', (_, x, left) => {
    const rendered = plan([click(2000, x)]);
    expect(view(rendered, 3000).x).toBeCloseTo(left, 6);
  });

  it('skips a move under the dead zone, 10 % of the crop width', () => {
    // 100 px is under 10 % of the 1080 px crop (108 px); 150 px is over it.
    const still = plan([click(2000, 1060)]);
    expect(still.square?.follow).toHaveLength(1);
    expect(centreX(still, 3000)).toBe(960);
    const moved = plan([click(2000, 1110)]);
    expect(centreX(moved, 3000)).toBeCloseTo(1110, 6);
    const wide = plan([click(2000, 1110)], { square: { deadZone: 0.2 } });
    expect(centreX(wide, 3000)).toBe(960);
  });

  it('keeps its own follow keys, apart from the vertical crop', () => {
    // 100 px is a move for the 608 px vertical crop, none for the square one.
    const rendered = plan([click(2000, 1060)]);
    expect(rendered.vertical?.follow.length).toBeGreaterThan(1);
    expect(rendered.square?.follow).toHaveLength(1);
    const tuned = plan([click(2000, 1500)], {
      vertical: { followMs: 100 },
      square: { followMs: 800 },
    });
    expect(tuned.vertical?.follow.at(-1)?.atMs).toBe(2000 - 100 + 100);
    expect(tuned.square?.follow.at(-1)?.atMs).toBe(2000);
  });

  it('composes a step zoom with the crop, on the zoom keyframes', () => {
    const rendered = plan([click(2000, 1500, { zoom: 1.5 })]);
    // The press of the click: 100 ms before its end, zoomed in by then.
    const box = view(rendered, 2900);
    expect(box.width).toBeCloseTo(CROP.width / 1.5, 6);
    expect(box.height).toBeCloseTo(CROP.height / 1.5, 6);
    expect(box.x + box.width / 2).toBeCloseTo(1500, 6);
    expect(box.y + box.height / 2).toBeCloseTo(540, 6);
    // And out again at zoom 1, still on the target.
    expect(view(rendered, 8000).width).toBeCloseTo(CROP.width, 6);
  });

  it('lays captions in the bottom 22 % at 44 px or more, up to 2 lines', () => {
    const { caption } = plan([]).square ?? {};
    expect(caption).toEqual({
      top: 1080 - Math.round(1080 * 0.22),
      height: Math.round(1080 * 0.22),
      fontPx: SQUARE.captionFontPx,
      maxLines: 2,
    });
    expect(caption?.height).toBe(238);
    expect(caption?.fontPx).toBeGreaterThanOrEqual(44);
    const tall = plan([], { square: { captionBand: 0.3 } }).square;
    expect(tall?.caption.height).toBe(Math.round(1080 * 0.3));
  });

  it('fills the frame with the crop and shows the landscape caption at the same time', () => {
    const rendered = plan([click(2000, 1500, { caption: 'Save the invoice' })]);
    const frame = Math.round((2500 * 30) / 1000);
    const wide = frameAt(rendered, frame);
    const square = frameAt(rendered, frame, 'square');
    expect(square.content).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    expect(square.frame).toBeUndefined();
    expect(square.caption).toBe('Save the invoice');
    expect(square.caption).toBe(wide.caption);
    expect(square.sourceMs).toBe(wide.sourceMs);
    expect(square.crop).toEqual(view(rendered, 2500));
    expect(square.cursor?.x).toBeGreaterThan(0);
    expect(square.cursor?.x).toBeLessThan(1080);
  });

  it('draws cards in the square layout with the same content', () => {
    const rendered = plan([click(2000, 1500)], {
      cards: CardsConfigSchema.parse({}),
    });
    const square = frameAt(rendered, 0, 'square');
    expect(square.card).toEqual(frameAt(rendered, 0).card);
    expect(square.card?.title).toBe('inline');
  });

  it('refuses a square frame of a plan without the square output', () => {
    expect(() => frameAt(plan([], { formats: ['mp4'] }), 0, 'square')).toThrow(
      /square format/,
    );
  });
});
