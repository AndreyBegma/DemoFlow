import {
  deriveRunStatus,
  type RunResult,
  type Stages,
  type Timeline,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  cameraAt,
  DEFAULT_OFFSET_MS,
  frameAt,
  frameCount,
  type Interval,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
  toOutputMs,
} from '../../src/index.ts';

const VIEWPORT = { width: 1280, height: 720 };

function timeline(events: TimelineEvent[]): Timeline {
  return {
    schemaVersion: 1,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    videoFile: 'source.webm',
    events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
  };
}

function result(failed?: {
  stage: 'execution' | 'verification';
  stepIndex: number;
  message: string;
}): RunResult {
  const passed = { status: 'passed' as const };
  const stages: Stages = {
    readiness: passed,
    execution: passed,
    verification: passed,
    recording: passed,
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
  if (failed !== undefined) {
    stages[failed.stage] = {
      status: 'failed',
      error: { message: failed.message, stepIndex: failed.stepIndex },
    };
  }
  return {
    schemaVersion: 1,
    runId: 'run',
    scenarioId: 'inline',
    scenarioName: 'inline',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

/** No clock offset unless a test sets one, so output times read off the timeline. */
function plan(
  events: TimelineEvent[],
  freezes: Interval[],
  options: RenderPlanOptions & { failed?: Parameters<typeof result>[0] } = {},
): RenderPlan {
  const { failed, ...rest } = options;
  return planRender(
    {
      timeline: timeline(events),
      result: result(failed),
      source: {
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes,
      },
    },
    { offsetMs: 0, ...rest },
  );
}

/** `stepIndex` is filled in by `timeline()`. */
function event(e: Omit<TimelineEvent, 'stepIndex'>): TimelineEvent {
  return { stepIndex: 0, ...e };
}

function click(
  startMs: number,
  endMs: number,
  centre: { x: number; y: number },
  from = { x: 640, y: 360 },
): TimelineEvent {
  return event({
    action: 'click',
    startMs,
    endMs,
    target: {
      box: { x: centre.x - 60, y: centre.y - 14, width: 120, height: 28 },
    },
    pointer: { from, to: centre },
  });
}

function zoomAt(rendered: RenderPlan, atMs: number): number {
  return VIEWPORT.width / cameraAt(rendered, atMs).width;
}

function frames(rendered: RenderPlan, from: number, to: number): number[] {
  const fps = rendered.output.fps;
  const out: number[] = [];
  for (let f = Math.ceil((from * fps) / 1000); (f * 1000) / fps < to; f++) {
    out.push(f);
  }
  return out;
}

describe('time map', () => {
  it('compresses a 3 000 ms idle gap between events to 400 ms', () => {
    const rendered = plan(
      [
        event({ action: 'navigate', startMs: 0, endMs: 500 }),
        click(500, 1000, { x: 300, y: 200 }),
        // Nothing happens from 1 000 to 4 000 ms, and the frame is frozen.
        click(4000, 4600, { x: 900, y: 500 }, { x: 300, y: 200 }),
      ],
      [{ startMs: 1000, endMs: 4000 }],
    );
    expect(rendered.timeMap).toContainEqual({
      sourceStartMs: 1000,
      sourceEndMs: 4000,
      outputStartMs: 1000,
      outputEndMs: 1400,
    });
    // The second click now happens at 1 400 ms of output.
    expect(toOutputMs(rendered.timeMap, 4000)).toBe(1400);
    expect(rendered.durationMs).toBe(4600 + 1000 - 2600);
  });

  it('compresses a frozen passive step (a wait, a failed assertion)', () => {
    const rendered = plan(
      [
        click(0, 1000, { x: 300, y: 200 }),
        event({ action: 'wait', startMs: 1000, endMs: 4000 }),
        click(4000, 4600, { x: 900, y: 500 }),
      ],
      [{ startMs: 1000, endMs: 4000 }],
    );
    expect(toOutputMs(rendered.timeMap, 4000)).toBe(1400);
  });

  it('keeps a 1 500 ms spinner: the frame changes, so it is never frozen', () => {
    const rendered = plan(
      [
        click(0, 1000, { x: 300, y: 200 }),
        event({
          action: 'waitFor',
          startMs: 1000,
          endMs: 2500,
          target: { box: { x: 600, y: 300, width: 80, height: 80 } },
        }),
        click(2500, 3100, { x: 900, y: 500 }),
      ],
      // FFmpeg finds no freeze while the spinner turns; only after the video ends.
      [{ startMs: 4100, endMs: 20_000 }],
    );
    expect(toOutputMs(rendered.timeMap, 1000)).toBe(1000);
    expect(toOutputMs(rendered.timeMap, 2500)).toBe(2500);
  });

  it('never compresses a frozen frame during an active event', () => {
    // A slow typing field whose frame FFmpeg calls frozen is still the action.
    const rendered = plan(
      [
        event({
          action: 'fill',
          startMs: 0,
          endMs: 3000,
          target: { box: { x: 100, y: 100, width: 300, height: 28 } },
          value: 'x',
        }),
      ],
      [{ startMs: 0, endMs: 3000 }],
    );
    expect(toOutputMs(rendered.timeMap, 3000)).toBe(3000);
  });

  it('is contiguous and monotonic from 0', () => {
    const rendered = plan(
      [
        click(0, 1000, { x: 300, y: 200 }),
        event({ action: 'wait', startMs: 1000, endMs: 3000 }),
        event({ action: 'wait', startMs: 3000, endMs: 3500 }),
        click(3500, 4000, { x: 900, y: 500 }),
        event({ action: 'wait', startMs: 4000, endMs: 7000 }),
      ],
      [
        { startMs: 1000, endMs: 3500 },
        { startMs: 4000, endMs: 20_000 },
      ],
    );
    let output = 0;
    let source = 0;
    for (const segment of rendered.timeMap) {
      expect(segment.outputStartMs).toBe(output);
      expect(segment.sourceStartMs).toBe(source);
      expect(segment.outputEndMs).toBeGreaterThan(segment.outputStartMs);
      output = segment.outputEndMs;
      source = segment.sourceEndMs;
    }
    // The run ends 1 000 ms after its last event; that tail is frozen too.
    expect(source).toBe(8000);
  });

  it('applies the clock offset: source = timeline + offsetMs', () => {
    const rendered = plan([click(1000, 2000, { x: 300, y: 200 })], [], {
      offsetMs: -100,
    });
    expect(rendered.offsetMs).toBe(-100);
    expect(rendered.cursor[0].startMs).toBe(900);
    expect(rendered.clicks[0].atMs).toBe(1800);
  });

  it('defaults the offset to the lead #3 measured', () => {
    const rendered = planRender({
      timeline: timeline([click(1000, 2000, { x: 300, y: 200 })]),
      result: result(),
      source: {
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 5000,
        codec: 'vp9',
        freezes: [],
      },
    });
    expect(rendered.offsetMs).toBe(-100);
  });
});

describe('sync mark', () => {
  const password = { x: 264, y: 230, width: 384, height: 28 };
  const events = [
    event({ action: 'navigate', startMs: 180, endMs: 600 }),
    event({
      action: 'fill',
      startMs: 1000,
      endMs: 1600,
      target: { box: password },
      masked: true,
      value: '***',
      maskVisibility: [{ startMs: 600, box: password }],
    }),
    event({ action: 'wait', startMs: 1600, endMs: 3000 }),
  ];
  const mark = { colour: '#ff00ff', onMs: 25, offMs: 180 };

  /** No `offsetMs` option: the plan picks the offset itself. */
  function planWith(
    syncMark: typeof mark | undefined,
    syncClearMs: number | undefined,
  ): RenderPlan {
    return planRender({
      timeline: {
        ...timeline(events),
        ...(syncMark === undefined ? {} : { syncMark }),
      },
      result: result(),
      source: {
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 5000,
        codec: 'vp9',
        freezes: [],
      },
      ...(syncClearMs === undefined ? {} : { syncClearMs }),
    });
  }

  it('measures the offset on the clear and pads masks by one source frame', () => {
    const rendered = planWith(mark, 120);
    expect(rendered.offsetMs).toBe(120 - 180);
    expect(rendered.offsetMeasured).toBe(true);
    expect(rendered.maskLeadMs).toBe(40);
    // The output starts on the first frame after the mark (Decision 6).
    expect(rendered.timeMap[0].sourceStartMs).toBe(120);
    expect(frameAt(rendered, 0).sourceMs).toBe(120);
    // Field on the page at 600 → source 540 → output 420; less one frame.
    expect(rendered.masks[0].startMs).toBeCloseTo(540 - 120 - 40);
  });

  // #48: an end padded like the start, so a field never shows for the last frame.
  it('ends a mask one source frame after out(endMs) when the offset is measured, 200 ms when not', () => {
    const closed = events.map((item) =>
      item.masked === true
        ? {
            ...item,
            maskVisibility: [{ startMs: 600, endMs: 2000, box: password }],
          }
        : item,
    );
    const render = (syncClearMs: number | undefined): RenderPlan =>
      planRender({
        timeline: { ...timeline(closed), syncMark: mark },
        result: result(),
        source: {
          width: 1280,
          height: 720,
          fps: 25,
          durationMs: 5000,
          codec: 'vp9',
          freezes: [],
        },
        ...(syncClearMs === undefined ? {} : { syncClearMs }),
      });

    const measured = render(120);
    expect(measured.maskTrailMs).toBe(40);
    // Off the page at 2000 → source 1940 → output 1820; plus one frame.
    expect(measured.masks[0].endMs).toBeCloseTo(1940 - 120 + 40);

    const unmeasured = render(undefined);
    expect(unmeasured.maskTrailMs).toBe(200);
    expect(unmeasured.masks[0].endMs).toBeCloseTo(
      2000 + DEFAULT_OFFSET_MS + 200,
    );
  });

  it('keeps the defaults without a sync mark', () => {
    const rendered = planWith(undefined, 120);
    expect(rendered.offsetMs).toBe(DEFAULT_OFFSET_MS);
    expect(rendered.offsetMeasured).toBe(false);
    expect(rendered.maskLeadMs).toBe(200);
    expect(rendered.timeMap[0].sourceStartMs).toBe(0);
    expect(rendered.masks[0].startMs).toBeCloseTo(
      600 + DEFAULT_OFFSET_MS - 200,
    );
  });

  it('keeps the defaults, and the whole video, when the mark was not found', () => {
    const rendered = planWith(mark, undefined);
    expect(rendered.offsetMs).toBe(DEFAULT_OFFSET_MS);
    expect(rendered.offsetMeasured).toBe(false);
    expect(rendered.maskLeadMs).toBe(200);
    expect(rendered.timeMap[0].sourceStartMs).toBe(0);
  });

  it('keeps the defaults when the measured offset is implausible', () => {
    const rendered = planWith(mark, 2_000);
    expect(rendered.offsetMs).toBe(DEFAULT_OFFSET_MS);
    expect(rendered.maskLeadMs).toBe(200);
    expect(rendered.timeMap[0].sourceStartMs).toBe(0);
  });

  it('lets an explicit offset win, with the 200 ms lead, and still trims the mark', () => {
    const rendered = planRender(
      {
        timeline: { ...timeline(events), syncMark: mark },
        result: result(),
        source: {
          width: 1280,
          height: 720,
          fps: 25,
          durationMs: 5000,
          codec: 'vp9',
          freezes: [],
        },
        syncClearMs: 120,
      },
      { offsetMs: -100 },
    );
    expect(rendered.offsetMs).toBe(-100);
    expect(rendered.offsetMeasured).toBe(false);
    expect(rendered.maskLeadMs).toBe(200);
    expect(rendered.timeMap[0].sourceStartMs).toBe(120);
  });
});

describe('camera', () => {
  it('keeps one continuous zoom over two clicks 200 px apart', () => {
    const rendered = plan(
      [
        // Away from the edges, so the view is not clamped to the frame.
        click(0, 1000, { x: 560, y: 300 }),
        event({ action: 'wait', startMs: 1000, endMs: 2500 }),
        click(2500, 3500, { x: 760, y: 300 }, { x: 560, y: 300 }),
      ],
      [],
    );
    const firstPress = rendered.clicks[0].atMs;
    const secondPress = rendered.clicks[1].atMs;
    for (const frame of frames(rendered, firstPress, secondPress + 1)) {
      const atMs = (frame * 1000) / rendered.output.fps;
      expect(zoomAt(rendered, atMs), `zoom at ${atMs} ms`).toBeCloseTo(1.25);
    }
    // It pans: the view centre moves from one target to the other.
    const before = cameraAt(rendered, firstPress);
    const after = cameraAt(rendered, secondPress);
    expect(after.x - before.x).toBeCloseTo(200);
  });

  it('zooms out between two distant clicks far apart in time', () => {
    const rendered = plan(
      [
        click(0, 1000, { x: 200, y: 200 }),
        event({ action: 'wait', startMs: 1000, endMs: 4000 }),
        click(4000, 5000, { x: 1100, y: 600 }, { x: 200, y: 200 }),
      ],
      [],
    );
    expect(zoomAt(rendered, rendered.clicks[0].atMs)).toBeCloseTo(1.25);
    expect(zoomAt(rendered, 2500)).toBe(1);
    expect(zoomAt(rendered, rendered.clicks[1].atMs)).toBeCloseTo(1.25);
  });

  it('eases in over 500 ms before the action and out over 400 ms after', () => {
    const rendered = plan([click(1000, 2000, { x: 400, y: 300 })], []);
    const press = rendered.clicks[0].atMs;
    expect(zoomAt(rendered, press - 501)).toBe(1);
    expect(zoomAt(rendered, press - 250)).toBeGreaterThan(1);
    expect(zoomAt(rendered, press)).toBeCloseTo(1.25);
    expect(zoomAt(rendered, press + 200)).toBeGreaterThan(1);
    expect(zoomAt(rendered, press + 401)).toBe(1);
  });

  it('zooms 1.6× on a 2× source and never leaves the frame', () => {
    const rendered = planRender(
      {
        timeline: timeline([click(1000, 2000, { x: 20, y: 20 })]),
        result: result(),
        source: {
          width: 2560,
          height: 1440,
          fps: 25,
          durationMs: 5000,
          codec: 'vp9',
          freezes: [],
        },
      },
      { offsetMs: 0 },
    );
    expect(rendered.source.scale).toBe(2);
    const view = cameraAt(rendered, rendered.clicks[0].atMs);
    expect(VIEWPORT.width / view.width).toBeCloseTo(1.6);
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
  });
});

describe('cursor and clicks', () => {
  it('is hidden before the first pointer event, glides, then rests', () => {
    const rendered = plan(
      [
        event({ action: 'navigate', startMs: 0, endMs: 500 }),
        click(500, 1500, { x: 300, y: 200 }, { x: 640, y: 360 }),
        event({ action: 'wait', startMs: 1500, endMs: 2500 }),
      ],
      [],
    );
    expect(frameAt(rendered, 0).cursor).toBeUndefined();
    // The press is 100 ms before the click's end.
    expect(rendered.cursor[0]).toMatchObject({ startMs: 500, endMs: 1400 });
    expect(rendered.clicks).toEqual([
      { atMs: 1400, durationMs: 300, point: { x: 300, y: 200 } },
    ]);
    const resting = frameAt(rendered, 60);
    const later = frameAt(rendered, 70);
    expect(resting.cursor).toEqual(later.cursor);
    // Frame 45 is 1 500 ms: 100 ms into the 300 ms ring.
    const ring = frameAt(rendered, 45);
    expect(ring.rings).toHaveLength(1);
    expect(ring.rings[0].progress).toBeCloseTo(1 / 3);
  });
});

describe('masks', () => {
  const password = { x: 264, y: 230, width: 384, height: 28 };
  const masked = event({
    action: 'fill',
    startMs: 800,
    endMs: 1400,
    target: { box: password },
    masked: true,
    value: '***',
  });

  it('covers the masked field for its whole visible span, until the page navigates', () => {
    const rendered = plan(
      [
        event({ action: 'navigate', startMs: 0, endMs: 100 }),
        masked,
        click(1400, 1800, { x: 456, y: 284 }),
        event({ action: 'navigate', startMs: 1800, endMs: 2100 }),
        event({ action: 'wait', startMs: 2100, endMs: 3000 }),
      ],
      [],
    );
    expect(rendered.masks).toHaveLength(1);
    const [mask] = rendered.masks;
    expect(mask.startMs).toBe(600);
    // The navigation ends at 2100; the 200 ms trail of an unmeasured offset (#48).
    expect(mask.endMs).toBe(2300);
    for (const frame of frames(rendered, 800, 2100)) {
      const state = frameAt(rendered, frame);
      expect(state.masks, `frame ${frame}`).toHaveLength(1);
      const [box] = state.masks;
      // The field's box, in output pixels, lies inside the mask.
      const view = cameraAt(rendered, (frame * 1000) / rendered.output.fps);
      const left = state.content.x + (password.x - view.x) * state.scale;
      const top = state.content.y + (password.y - view.y) * state.scale;
      expect(box.x).toBeLessThanOrEqual(left);
      expect(box.y).toBeLessThanOrEqual(top);
      expect(box.x + box.width).toBeGreaterThanOrEqual(
        left + password.width * state.scale,
      );
      expect(box.y + box.height).toBeGreaterThanOrEqual(
        top + password.height * state.scale,
      );
    }
    expect(frameAt(rendered, frames(rendered, 2300, 2400)[0]).masks).toEqual(
      [],
    );
  });

  it('follows a page scroll and ends when the field has left the viewport', () => {
    const rendered = plan(
      [
        masked,
        event({
          action: 'scroll',
          startMs: 1400,
          endMs: 2400,
          scroll: { before: { x: 0, y: 0 }, after: { x: 0, y: 2000 } },
        }),
        event({ action: 'wait', startMs: 2400, endMs: 4000 }),
      ],
      [],
    );
    const [mask] = rendered.masks;
    expect(mask.endMs).toBe(2600);
    expect(mask.keys.at(-1)?.box.y).toBe(password.y - 4 - 2000);
  });

  it('lasts to the end of the video when nothing navigates', () => {
    const rendered = plan(
      [masked, event({ action: 'wait', startMs: 1400, endMs: 2000 })],
      [],
    );
    expect(rendered.masks[0].endMs).toBe(rendered.durationMs);
  });

  // #42: a masked fill whose field could not be measured has no box to blur.
  it('masks the whole viewport from its start, past a navigation, when the masked event has no box', () => {
    const { target: _, ...unmeasured } = masked;
    const rendered = plan(
      [
        unmeasured,
        event({ action: 'navigate', startMs: 1400, endMs: 1800 }),
        event({ action: 'wait', startMs: 1800, endMs: 3000 }),
      ],
      [],
    );
    expect(rendered.masks).toHaveLength(1);
    const [mask] = rendered.masks;
    expect(mask.startMs).toBe(600);
    expect(mask.endMs).toBe(rendered.durationMs);
    for (const { box } of mask.keys) {
      expect(box.x).toBeLessThanOrEqual(0);
      expect(box.y).toBeLessThanOrEqual(0);
      expect(box.x + box.width).toBeGreaterThanOrEqual(VIEWPORT.width);
      expect(box.y + box.height).toBeGreaterThanOrEqual(VIEWPORT.height);
    }
    const [frame] = frames(rendered, 800, 900);
    const state = frameAt(rendered, frame);
    expect(state.masks).toHaveLength(1);
    const [box] = state.masks;
    expect(box.x).toBeLessThanOrEqual(state.content.x);
    expect(box.y).toBeLessThanOrEqual(state.content.y);
    expect(box.x + box.width).toBeGreaterThanOrEqual(
      state.content.x + VIEWPORT.width * state.scale,
    );
    expect(box.y + box.height).toBeGreaterThanOrEqual(
      state.content.y + VIEWPORT.height * state.scale,
    );
  });

  describe('with maskVisibility', () => {
    const withVisibility = (
      maskVisibility: NonNullable<TimelineEvent['maskVisibility']>,
    ): TimelineEvent => ({ ...masked, maskVisibility });

    it('ends the mask with the interval plus the trail, so none is active after the sign-in click', () => {
      const rendered = plan(
        [
          event({ action: 'navigate', startMs: 0, endMs: 100 }),
          withVisibility([{ startMs: 800, endMs: 1800, box: password }]),
          click(1400, 1800, { x: 456, y: 284 }),
          event({ action: 'wait', startMs: 1800, endMs: 3000 }),
        ],
        [],
      );
      expect(rendered.masks).toHaveLength(1);
      expect(rendered.masks[0]).toMatchObject({ startMs: 600, endMs: 2000 });
      expect(
        frameAt(rendered, frames(rendered, 1900, 2000)[0]).masks,
      ).toHaveLength(1);
      for (const frame of frames(rendered, 2000, rendered.durationMs)) {
        expect(frameAt(rendered, frame).masks, `frame ${frame}`).toEqual([]);
      }
    });

    it('runs an open interval to the end of the video', () => {
      const rendered = plan(
        [
          withVisibility([{ startMs: 800, box: password }]),
          event({ action: 'wait', startMs: 1400, endMs: 2000 }),
        ],
        [],
      );
      expect(rendered.masks).toHaveLength(1);
      expect(rendered.masks[0].endMs).toBe(rendered.durationMs);
    });

    it('emits a span per interval, each with its own box', () => {
      const back = { x: 100, y: 400, width: 300, height: 28 };
      const rendered = plan(
        [
          withVisibility([
            { startMs: 800, endMs: 1500, box: password },
            { startMs: 2000, box: back },
          ]),
          event({ action: 'wait', startMs: 1400, endMs: 3000 }),
        ],
        [],
      );
      expect(rendered.masks).toHaveLength(2);
      expect(rendered.masks[0]).toMatchObject({ startMs: 600, endMs: 1700 });
      expect(rendered.masks[1]).toMatchObject({
        startMs: 1800,
        endMs: rendered.durationMs,
      });
      expect(rendered.masks[1].keys[0].box).toEqual({
        x: back.x - 4,
        y: back.y - 4,
        width: back.width + 8,
        height: back.height + 8,
      });
      expect(frameAt(rendered, frames(rendered, 1700, 1750)[0]).masks).toEqual(
        [],
      );
    });

    it('masks both boxes while two intervals overlap', () => {
      const moved = { x: 300, y: 300, width: 384, height: 28 };
      const rendered = plan(
        [
          withVisibility([
            { startMs: 800, endMs: 2000, box: password },
            { startMs: 1800, box: moved },
          ]),
          event({ action: 'wait', startMs: 2000, endMs: 3000 }),
        ],
        [],
      );
      expect(rendered.masks).toHaveLength(2);
      expect(
        frameAt(rendered, frames(rendered, 1900, 1950)[0]).masks,
      ).toHaveLength(2);
    });

    it('follows a page scroll inside an interval and keeps the span when the box leaves the viewport', () => {
      const rendered = plan(
        [
          withVisibility([{ startMs: 800, box: password }]),
          event({
            action: 'scroll',
            startMs: 1400,
            endMs: 2400,
            scroll: { before: { x: 0, y: 0 }, after: { x: 0, y: 2000 } },
          }),
          event({ action: 'wait', startMs: 2400, endMs: 4000 }),
        ],
        [],
      );
      const [mask] = rendered.masks;
      expect(mask.endMs).toBe(rendered.durationMs);
      expect(mask.keys.at(-1)?.box.y).toBe(password.y - 4 - 2000);
    });

    it('ignores a scroll that starts after the interval closed', () => {
      const rendered = plan(
        [
          withVisibility([{ startMs: 800, endMs: 1400, box: password }]),
          event({
            action: 'scroll',
            startMs: 1500,
            endMs: 2400,
            scroll: { before: { x: 0, y: 0 }, after: { x: 0, y: 200 } },
          }),
        ],
        [],
      );
      expect(rendered.masks[0].keys).toHaveLength(1);
    });
  });
});

describe('captions', () => {
  it('shows step captions and caption markers for the step plus 800 ms', () => {
    const rendered = plan(
      [
        event({
          action: 'marker',
          startMs: 0,
          endMs: 0,
          marker: { title: 'Scene', kind: 'scene' },
        }),
        event({
          action: 'marker',
          startMs: 0,
          endMs: 1,
          marker: { title: 'Slow report', kind: 'caption' },
        }),
        { ...click(3000, 4000, { x: 300, y: 200 }), caption: 'Open it' },
        event({ action: 'wait', startMs: 4000, endMs: 6000 }),
      ],
      [],
    );
    expect(rendered.captions).toEqual([
      { startMs: 0, endMs: 801, text: 'Slow report' },
      { startMs: 3000, endMs: 4800, text: 'Open it' },
    ]);
  });
});

describe('key badges', () => {
  const box = { x: 100, y: 200, width: 200, height: 40 };

  it('hangs a badge below the target of a press, from its start to 600 ms after its end', () => {
    const rendered = plan(
      [
        event({
          action: 'press',
          startMs: 1000,
          endMs: 1500,
          key: 'Control+a',
          target: { box },
          pointer: { from: { x: 0, y: 0 }, to: { x: 200, y: 220 } },
        }),
        event({ action: 'wait', startMs: 1500, endMs: 3000 }),
      ],
      [],
    );
    expect(rendered.keys).toEqual([
      {
        startMs: 1000,
        endMs: 2100,
        text: 'Control + a',
        anchor: { x: 200, y: 240 },
      },
    ]);
    const frame = (atMs: number) =>
      frameAt(rendered, Math.round((atMs * rendered.output.fps) / 1000));
    expect(frame(900).key).toBeUndefined();
    expect(frame(1200).key?.text).toBe('Control + a');
    expect(frame(2200).key).toBeUndefined();
  });

  it('hangs a press without a target from where the pointer last rested', () => {
    const rendered = plan(
      [
        click(0, 500, { x: 300, y: 200 }),
        event({ action: 'press', startMs: 600, endMs: 700, key: 'Enter' }),
      ],
      [],
    );
    expect(rendered.keys[0]?.anchor).toEqual({ x: 300, y: 200 });
  });

  it('cuts a badge when the next one starts', () => {
    const rendered = plan(
      [
        event({ action: 'press', startMs: 0, endMs: 100, key: 'Tab' }),
        event({ action: 'press', startMs: 300, endMs: 400, key: 'Tab' }),
      ],
      [],
    );
    expect(rendered.keys.map((badge) => badge.endMs)).toEqual([300, 1000]);
  });
});

describe('failure', () => {
  const steps = [
    event({ action: 'navigate', startMs: 0, endMs: 100 }),
    event({ action: 'assertVisible', startMs: 100, endMs: 200 }),
    event({
      action: 'assertText',
      startMs: 200,
      endMs: 10_200,
      assertion: { passed: false, message: 'expected Clients' },
    }),
  ];

  it('watermarks every frame and ends on a 3 s card naming the step', () => {
    const rendered = plan(steps, [{ startMs: 400, endMs: 20_000 }], {
      failed: {
        stage: 'verification',
        stepIndex: 2,
        message: 'expected Clients',
      },
    });
    expect(rendered.failure?.endCard.text).toBe(
      'Verification failed at step 3: expected Clients',
    );
    // The video runs to the failing step's end: 10 200 ms with 9 800 frozen → 400.
    const videoEndMs = 400 + 400;
    expect(rendered.timeMap.at(-1)?.sourceEndMs).toBe(10_200);
    expect(rendered.failure?.endCard.startMs).toBe(videoEndMs);
    expect(rendered.durationMs).toBe(videoEndMs + 3000);

    const last = frameCount(rendered) - 1;
    expect(frameAt(rendered, 0).watermark).toBe(true);
    expect(frameAt(rendered, last).watermark).toBe(true);
    expect(frameAt(rendered, last).endCard).toBe(
      'Verification failed at step 3: expected Clients',
    );
    expect(frameAt(rendered, last).sourceMs).toBeNull();
  });

  it('does not watermark a run whose earlier render failed', () => {
    const run = result();
    run.stages.rendering = { status: 'failed', error: { message: 'boom' } };
    run.status = 'failed';
    const rendered = planRender(
      {
        timeline: timeline(steps.slice(0, 2)),
        result: run,
        source: {
          width: 1280,
          height: 720,
          fps: 25,
          durationMs: 3000,
          codec: 'vp9',
          freezes: [],
        },
      },
      { offsetMs: 0 },
    );
    expect(rendered.failure).toBeUndefined();
    expect(frameAt(rendered, 0).watermark).toBe(false);
  });
});

describe('output', () => {
  it('is 1920×1080, 30 fps, H.264, yuv420p, faststart; the viewport fills it', () => {
    const rendered = plan([click(0, 1000, { x: 300, y: 200 })], []);
    expect(rendered.output).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      faststart: true,
    });
    expect(rendered.fit).toEqual({ x: 0, y: 0, scale: 1.5 });
    expect(frameAt(rendered, 0).content).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });
});
