import {
  CardsConfigSchema,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  frameAt,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
  renderPath,
  VERTICAL,
  verticalViewAt,
} from '../../src/index.ts';

/** Spec 176: the 9:16 crop that follows each step's target. */

const VIEWPORT = { width: 1280, height: 720 };
/** The crop at zoom 1: the viewport's height, 9:16. */
const CROP = { width: (720 * 9) / 16, height: 720 };

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
  startedAt: '2026-10-22T10:00:00.000Z',
  finishedAt: '2026-10-22T10:00:10.000Z',
  status: 'completed',
  stages: STAGES,
  renders: [],
  warnings: [],
};

function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  options: RenderPlanOptions = {},
): RenderPlan {
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        videoFile: 'source.webm',
        events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
      },
      result: RESULT,
      source: {
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes: [],
      },
    },
    {
      offsetMs: 0,
      frame: { enabled: false },
      formats: ['mp4', 'mp4-vertical'],
      ...options,
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
    target: { box: { x: x - 60, y: 346, width: 120, height: 28 } },
    pointer: { from: { x: 640, y: 360 }, to: { x, y: 360 } },
    ...extra,
  };
}

function view(rendered: RenderPlan, atMs: number) {
  const { vertical } = rendered;
  if (vertical === undefined) throw new Error('no vertical output planned');
  return verticalViewAt(rendered, vertical, atMs);
}

function centreX(rendered: RenderPlan, atMs: number): number {
  const box = view(rendered, atMs);
  return box.x + box.width / 2;
}

describe('the vertical output (spec 176)', () => {
  it('is planned only when mp4-vertical is asked for, at 1080×1920', () => {
    expect(plan([], { formats: ['mp4'] }).vertical).toBeUndefined();
    const rendered = plan([], { formats: ['mp4-vertical'] });
    expect(rendered.output.files).toEqual([
      {
        format: 'mp4-vertical',
        codec: 'h264',
        pixelFormat: 'yuv420p',
        faststart: true,
      },
    ]);
    expect(rendered.vertical).toMatchObject({ width: 1080, height: 1920 });
  });

  it('is written as <renderer>.vertical.mp4 beside the others', () => {
    expect(renderPath('run', 'ffmpeg', 'mp4-vertical')).toMatch(
      /render[/\\]ffmpeg\.vertical\.mp4$/,
    );
    expect(renderPath('run', 'ffmpeg', 'mp4')).toMatch(
      /render[/\\]ffmpeg\.mp4$/,
    );
  });

  it('crops the full page height at 9:16, starting on the page centre', () => {
    expect(view(plan([]), 0)).toEqual({
      x: 640 - CROP.width / 2,
      y: 0,
      width: CROP.width,
      height: CROP.height,
    });
  });

  it.each([
    ['left', 300],
    ['right', 1000],
  ])('follows a target on the %s, arriving as the step starts', (_, x) => {
    const rendered = plan([click(2000, x)]);
    expect(centreX(rendered, 1500)).toBe(640);
    expect(centreX(rendered, 2000)).toBeCloseTo(x, 6);
    expect(centreX(rendered, 5000)).toBeCloseTo(x, 6);
  });

  it('comes back to a target in the centre', () => {
    const rendered = plan([click(2000, 300), click(4000, 640)]);
    expect(centreX(rendered, 3000)).toBeCloseTo(300, 6);
    expect(centreX(rendered, 4000)).toBeCloseTo(640, 6);
  });

  it('eases each move over followMs, 400 by default', () => {
    const rendered = plan([click(2000, 1000)]);
    // Half-way through the move, easeInOut is at one half.
    expect(centreX(rendered, 1800)).toBeCloseTo((640 + 1000) / 2, 6);
    expect(centreX(rendered, 1600)).toBe(640);
    const quick = plan([click(2000, 1000)], { vertical: { followMs: 200 } });
    expect(centreX(quick, 1800)).toBe(640);
    expect(centreX(quick, 1900)).toBeCloseTo((640 + 1000) / 2, 6);
  });

  it.each([
    ['left', 20, 0],
    ['right', 1260, VIEWPORT.width - CROP.width],
  ])('clamps at the %s edge of the page', (_, x, left) => {
    const rendered = plan([click(2000, x)]);
    expect(view(rendered, 3000).x).toBeCloseTo(left, 6);
  });

  it('skips a move under the dead zone, 10 % of the crop width', () => {
    // 30 px is under 10 % of the 405 px crop; 60 px is over it.
    const still = plan([click(2000, 670)]);
    expect(still.vertical?.follow).toHaveLength(1);
    expect(centreX(still, 3000)).toBe(640);
    const moved = plan([click(2000, 700)]);
    expect(centreX(moved, 3000)).toBeCloseTo(700, 6);
    const wide = plan([click(2000, 700)], { vertical: { deadZone: 0.2 } });
    expect(centreX(wide, 3000)).toBe(640);
  });

  it('measures the dead zone where the clamped crop would go', () => {
    // Both targets clamp the crop to the left edge: the second is no move.
    const rendered = plan([click(2000, 20), click(4000, 150)]);
    expect(rendered.vertical?.follow).toHaveLength(3);
    expect(view(rendered, 5000).x).toBe(0);
  });

  it('keeps its position on a step without a target', () => {
    const rendered = plan([
      click(2000, 1000),
      { action: 'wait', startMs: 3000, endMs: 5000 },
    ]);
    expect(centreX(rendered, 4500)).toBeCloseTo(1000, 6);
  });

  it('composes a step zoom with the crop, on the zoom keyframes', () => {
    const rendered = plan([click(2000, 1000, { zoom: 1.5 })]);
    // The press of the click: 100 ms before its end, zoomed in by then.
    const box = view(rendered, 2900);
    expect(box.width).toBeCloseTo(CROP.width / 1.5, 6);
    expect(box.height).toBeCloseTo(CROP.height / 1.5, 6);
    expect(box.x + box.width / 2).toBeCloseTo(1000, 6);
    expect(box.y + box.height / 2).toBeCloseTo(360, 6);
    // And out again at zoom 1, still on the target.
    expect(view(rendered, 8000).width).toBeCloseTo(CROP.width, 6);
  });

  it('lays captions in the bottom 22 % at 44 px or more, up to 3 lines', () => {
    const { caption } = plan([]).vertical ?? {};
    expect(caption).toEqual({
      top: 1920 - Math.round(1920 * 0.22),
      height: Math.round(1920 * 0.22),
      fontPx: VERTICAL.captionFontPx,
      maxLines: 3,
    });
    expect(caption?.fontPx).toBeGreaterThanOrEqual(44);
    const tall = plan([], { vertical: { captionBand: 0.3 } }).vertical;
    expect(tall?.caption.height).toBe(Math.round(1920 * 0.3));
  });

  it('fills the frame with the crop and shows the landscape caption at the same time', () => {
    const rendered = plan([click(2000, 1000, { caption: 'Save the invoice' })]);
    const frame = Math.round((2500 * 30) / 1000);
    const wide = frameAt(rendered, frame);
    const tall = frameAt(rendered, frame, 'vertical');
    expect(tall.content).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(tall.frame).toBeUndefined();
    expect(tall.caption).toBe('Save the invoice');
    expect(tall.caption).toBe(wide.caption);
    expect(tall.sourceMs).toBe(wide.sourceMs);
    // The crop in source pixels: the view, at the source's scale of 1.
    const box = view(rendered, 2500);
    expect(tall.crop).toEqual(box);
    // The cursor on its target stays inside the crop.
    expect(tall.cursor?.x).toBeGreaterThan(0);
    expect(tall.cursor?.x).toBeLessThan(1080);
  });

  it('draws cards in the vertical layout with the same content', () => {
    const rendered = plan([click(2000, 1000)], {
      cards: CardsConfigSchema.parse({}),
    });
    const tall = frameAt(rendered, 0, 'vertical');
    const wide = frameAt(rendered, 0);
    expect(tall.card).toEqual(wide.card);
    expect(tall.card?.title).toBe('inline');
  });

  it('refuses a vertical frame of a plan without the vertical output', () => {
    expect(() =>
      frameAt(plan([], { formats: ['mp4'] }), 0, 'vertical'),
    ).toThrow(/mp4-vertical/);
  });
});
