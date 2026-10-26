import {
  type Annotation,
  type CardsConfig,
  deriveRunStatus,
  type RunEdits,
  type RunResult,
  type Stages,
  type Timeline,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  buildTimeMap,
  frameAt,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
  toOutputMs,
  toSourceMs,
} from '../../src/index.ts';

const VIEWPORT = { width: 1280, height: 720 };
const SOURCE_FRAME_MS = 1000 / 25;
const FADE = { enabled: true, durationMs: 300 };

function result(): RunResult {
  const passed = { status: 'passed' as const };
  const stages: Stages = {
    readiness: passed,
    execution: passed,
    verification: passed,
    recording: passed,
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
  return {
    schemaVersion: 1,
    runId: 'run',
    scenarioId: 'inline',
    scenarioName: 'Create a customer',
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

function timeline(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  annotations?: Annotation[],
): Timeline {
  return {
    schemaVersion: 1,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    videoFile: 'source.webm',
    events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

/** No freezes and no offset: page time is timeline time until a cut. */
function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  edits: Omit<RunEdits, 'schemaVersion'> | undefined,
  options: RenderPlanOptions & { annotations?: Annotation[] } = {},
): RenderPlan {
  const { annotations, ...rest } = options;
  return planRender(
    {
      timeline: timeline(events, annotations),
      result: result(),
      source: {
        width: 2560,
        height: 1440,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes: [],
      },
      ...(edits === undefined ? {} : { edits: { schemaVersion: 1, ...edits } }),
    },
    { offsetMs: 0, frame: {}, ...rest },
  );
}

function click(
  startMs: number,
  endMs: number,
  extra: Partial<TimelineEvent> = {},
): Omit<TimelineEvent, 'stepIndex'> {
  return {
    action: 'click',
    startMs,
    endMs,
    target: { box: { x: 580, y: 346, width: 120, height: 28 } },
    pointer: { from: { x: 640, y: 360 }, to: { x: 640, y: 360 } },
    ...extra,
  };
}

const wait = (startMs: number, endMs: number) => ({
  action: 'wait' as const,
  startMs,
  endMs,
});

const scene = (atMs: number, title: string) => ({
  action: 'marker' as const,
  startMs: atMs,
  endMs: atMs,
  marker: { title, kind: 'scene' as const },
});

/** Every card off unless a test turns it on. */
function cards(overrides: Partial<CardsConfig> = {}): CardsConfig {
  return {
    intro: { enabled: false, durationMs: 2000 },
    scenes: { enabled: false, durationMs: 1500 },
    outro: { durationMs: 2500 },
    ...overrides,
  };
}

/** Output ms of every output frame of the plan. */
function frameTimes(rendered: RenderPlan): number[] {
  const { fps } = rendered.output;
  const count = Math.ceil((rendered.durationMs * fps) / 1000);
  return Array.from({ length: count }, (_, index) => (index * 1000) / fps);
}

const frameOf = (rendered: RenderPlan, outputMs: number): number =>
  Math.round((outputMs * rendered.output.fps) / 1000);

const CUT = { startMs: 3000, endMs: 5000 };

describe('buildTimeMap with cuts', () => {
  it('skips a cut: it plays in 0 ms and the page resumes on its end', () => {
    const map = buildTimeMap([], 10_000, 400, 0, [CUT]);
    expect(map).toEqual([
      {
        outputStartMs: 0,
        outputEndMs: 3000,
        sourceStartMs: 0,
        sourceEndMs: 3000,
      },
      {
        outputStartMs: 3000,
        outputEndMs: 3000,
        sourceStartMs: 3000,
        sourceEndMs: 5000,
      },
      {
        outputStartMs: 3000,
        outputEndMs: 8000,
        sourceStartMs: 5000,
        sourceEndMs: 10_000,
      },
    ]);
    expect(toOutputMs(map, 4000)).toBe(3000);
    expect(toSourceMs(map, 3000)).toBe(5000);
    expect(toSourceMs(map, 2999)).toBe(2999);
  });

  it('compresses only the half of an idle stretch a cut leaves', () => {
    const map = buildTimeMap([{ startMs: 2000, endMs: 6000 }], 10_000, 400, 0, [
      { startMs: 2000, endMs: 4000 },
    ]);
    expect(map).toEqual([
      {
        outputStartMs: 0,
        outputEndMs: 2000,
        sourceStartMs: 0,
        sourceEndMs: 2000,
      },
      {
        outputStartMs: 2000,
        outputEndMs: 2000,
        sourceStartMs: 2000,
        sourceEndMs: 4000,
      },
      {
        outputStartMs: 2000,
        outputEndMs: 2400,
        sourceStartMs: 4000,
        sourceEndMs: 6000,
      },
      {
        outputStartMs: 2400,
        outputEndMs: 6400,
        sourceStartMs: 6000,
        sourceEndMs: 10_000,
      },
    ]);
  });
});

describe('trim', () => {
  const events = [click(1000, 2000), wait(2000, 6000)];

  it('starts the page on the source frame of the trim’s start', () => {
    const rendered = plan(events, { trim: { startMs: 2000 } });
    expect(rendered.timeMap[0]).toMatchObject({
      outputStartMs: 0,
      sourceStartMs: 2000,
    });
    const first = frameAt(rendered, 0).sourceMs;
    expect(first).not.toBeNull();
    expect(Math.abs((first ?? 0) - 2000)).toBeLessThanOrEqual(SOURCE_FRAME_MS);
  });

  it('ends the page on the trim’s end, then plays the outro', () => {
    const rendered = plan(
      events,
      { trim: { endMs: 5000 } },
      { cards: cards({ outro: { title: 'Thanks', durationMs: 2500 } }) },
    );
    const page = rendered.timeMap.filter(
      (segment) => segment.sourceEndMs > segment.sourceStartMs,
    );
    expect(page.at(-1)).toMatchObject({ outputEndMs: 5000, sourceEndMs: 5000 });
    expect(rendered.cards).toEqual([
      expect.objectContaining({
        kind: 'outro',
        startMs: 5000,
        durationMs: 2500,
      }),
    ]);
    expect(rendered.durationMs).toBe(7500);
    const last = frameAt(rendered, frameOf(rendered, 5000) - 1).sourceMs;
    expect(Math.abs((last ?? 0) - 5000)).toBeLessThanOrEqual(SOURCE_FRAME_MS);
  });
});

describe('overlays across a cut', () => {
  it('drops a caption inside a cut and keeps one across it on both sides', () => {
    const events = [click(1000, 2000), wait(2000, 8000)];
    const rendered = plan(events, {
      cuts: [CUT, { startMs: 6000, endMs: 6500 }],
      captions: [
        { startMs: 2000, endMs: 5500, text: 'Across' },
        { startMs: 6100, endMs: 6400, text: 'Inside' },
      ],
    });
    expect(rendered.captions).toEqual([
      { startMs: 2000, endMs: 3500, text: 'Across' },
    ]);
    const shown = (ms: number) =>
      frameAt(rendered, frameOf(rendered, ms)).caption;
    expect(shown(2900)).toBe('Across');
    expect(shown(3100)).toBe('Across');
  });

  it('drops a step caption inside a cut and keeps one across it', () => {
    const events = [
      click(2000, 3500, { caption: 'Across' }),
      click(3500, 4500, { caption: 'Inside' }),
      wait(4500, 8000),
    ];
    const rendered = plan(events, undefined);
    expect(rendered.captions.map((caption) => caption.text)).toEqual([
      'Across',
      'Inside',
    ]);
    const cut = plan(events, { cuts: [CUT] });
    expect(cut.captions.map((caption) => caption.text)).toEqual(['Across']);
  });

  it('drops a click ring inside a cut', () => {
    const events = [click(1000, 2000), click(3500, 4500), wait(4500, 8000)];
    expect(plan(events, undefined).clicks).toHaveLength(2);
    const rendered = plan(events, { cuts: [CUT] });
    expect(rendered.clicks).toHaveLength(1);
    expect(rendered.clicks[0].atMs).toBeLessThan(CUT.startMs);
  });

  it('places no scene card whose marker is inside a cut', () => {
    const events = [
      scene(0, 'Start'),
      click(1000, 2000),
      scene(4000, 'Hidden'),
      click(4000, 4500),
      wait(4500, 8000),
    ];
    const options = {
      cards: cards({ scenes: { enabled: true, durationMs: 1500 } }),
    };
    const titles = (rendered: RenderPlan) =>
      rendered.cards.map((card) => card.title);
    expect(titles(plan(events, undefined, options))).toEqual([
      'Start',
      'Hidden',
    ]);
    expect(titles(plan(events, { cuts: [CUT] }, options))).toEqual(['Start']);
  });

  it('jumps the cursor across a cut instead of gliding through it', () => {
    const events = [
      click(2000, 4000, {
        pointer: { from: { x: 0, y: 0 }, to: { x: 1000, y: 0 } },
      }),
      wait(4000, 8000),
    ];
    const rendered = plan(events, { cuts: [{ startMs: 2500, endMs: 3500 }] });
    for (const move of rendered.cursor) {
      // No move is squeezed into the join's instant with a length.
      expect(move.endMs).toBeGreaterThanOrEqual(move.startMs);
      if (move.endMs === move.startMs) continue;
      expect(move.endMs <= 2500 || move.startMs >= 2500).toBe(true);
    }
  });
});

describe('transitions at a cut', () => {
  const events = [click(1000, 2000), wait(2000, 8000)];

  it('dissolves from the last frame before a cut with transitions on', () => {
    const rendered = plan(events, { cuts: [CUT] }, { transitions: FADE });
    expect(rendered.transitions?.holds).toEqual([
      {
        startMs: 3000,
        endMs: 3000,
        fadeEndMs: 3300,
        fadeMs: 300,
        sourceMs: 3000 - SOURCE_FRAME_MS,
        masks: [],
      },
    ]);
    const state = frameAt(rendered, frameOf(rendered, 3100));
    expect(state.sourceMs).toBeGreaterThanOrEqual(CUT.endMs);
    expect(state.fade?.from.sourceMs).toBe(3000 - SOURCE_FRAME_MS);
  });

  it('joins hard with transitions off', () => {
    const rendered = plan(
      events,
      { cuts: [CUT] },
      { transitions: { enabled: false, durationMs: 300 } },
    );
    expect(rendered.transitions).toBeUndefined();
    expect(frameAt(rendered, frameOf(rendered, 3100)).fade).toBeUndefined();
  });

  it('adds no dissolve for a trim', () => {
    const rendered = plan(
      events,
      { trim: { startMs: 1500, endMs: 7000 } },
      { transitions: FADE },
    );
    expect(rendered.transitions?.holds).toEqual([]);
  });
});

describe('masks at a cut', () => {
  const password = { x: 264, y: 230, width: 384, height: 28 };
  const VISIBLE = { startMs: 2000, endMs: 4000 };
  const events: Omit<TimelineEvent, 'stepIndex'>[] = [
    click(500, 1000),
    {
      action: 'fill',
      startMs: 1000,
      endMs: VISIBLE.startMs,
      target: { box: password },
      masked: true,
      value: '***',
      maskVisibility: [{ ...VISIBLE, box: password }],
    },
    wait(VISIBLE.startMs, 7000),
  ];
  const visible = (rendered: RenderPlan, sourceMs: number): boolean => {
    const timelineMs = sourceMs - rendered.offsetMs;
    return timelineMs >= VISIBLE.startMs && timelineMs < VISIBLE.endMs;
  };

  /** Every cut with an edge within 300 ms of a visibility edge, 10 ms apart. */
  const cuts = [VISIBLE.startMs, VISIBLE.endMs].flatMap((edgeMs) =>
    Array.from({ length: 61 }, (_, index) => edgeMs - 300 + index * 10).flatMap(
      (atMs) => [
        { startMs: atMs, endMs: atMs + 500 },
        { startMs: atMs - 500, endMs: atMs },
      ],
    ),
  );

  it.each([
    ['off', { enabled: false, durationMs: 300 }],
    ['on', FADE],
  ])('leaves no visible field unmasked on any output frame, transitions %s', (_, transitions) => {
    let liveChecked = 0;
    let heldChecked = 0;
    for (const cut of cuts) {
      const rendered = plan(events, { cuts: [cut] }, { transitions });
      for (const atMs of frameTimes(rendered)) {
        const where = `cut ${cut.startMs}–${cut.endMs}, frame at ${atMs}`;
        const live = toSourceMs(rendered.timeMap, atMs);
        if (visible(rendered, live)) {
          liveChecked++;
          expect(
            rendered.masks.some(
              (mask) => mask.startMs <= atMs && atMs < mask.endMs,
            ),
            where,
          ).toBe(true);
        }
        const hold = rendered.transitions?.holds.find(
          (entry) => entry.startMs <= atMs && atMs < entry.fadeEndMs,
        );
        if (hold?.sourceMs !== undefined && visible(rendered, hold.sourceMs)) {
          heldChecked++;
          expect(hold.masks.length, where).toBeGreaterThan(0);
        }
      }
    }
    // The sweep reaches visible frames, and with transitions held ones.
    expect(liveChecked).toBeGreaterThan(0);
    expect(heldChecked > 0).toBe(transitions.enabled);
  });
});
