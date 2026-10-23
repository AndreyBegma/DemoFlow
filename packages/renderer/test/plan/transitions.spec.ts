import {
  type CardsConfig,
  deriveRunStatus,
  type MaskedElement,
  type Navigation,
  type RunResult,
  type Stages,
  type Timeline,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  type FrameState,
  frameAt,
  frameCount,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
} from '../../src/index.ts';

const FPS = 30;
const FADE = { enabled: true, durationMs: 300 };
const FIELD = { x: 200, y: 120, width: 320, height: 60 };
/** The field's mask: its box grown by the 4 px margin. */
const MASKED = { x: 196, y: 116, width: 328, height: 68 };

function result(failedAt?: number): RunResult {
  const passed = { status: 'passed' as const };
  const stages: Stages = {
    readiness: passed,
    execution:
      failedAt === undefined
        ? passed
        : {
            status: 'failed',
            error: { message: 'boom', stepIndex: failedAt },
          },
    verification: passed,
    recording: passed,
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
  return {
    schemaVersion: 1,
    runId: 'run',
    scenarioId: 'inline',
    scenarioName: 'Sign in',
    startedAt: '2026-10-18T10:00:00.000Z',
    finishedAt: '2026-10-18T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

function cards(scenes: boolean): CardsConfig {
  return {
    intro: { enabled: false, durationMs: 2000 },
    scenes: { enabled: scenes, durationMs: 1500 },
    outro: { durationMs: 2500 },
  };
}

/**
 * A sign-in: the first load (0–700), a masked password, a click whose
 * navigation loads 1950–2900, a scene marker at 2000 inside that load. The
 * password's field was last measured at the click's end, long before the new
 * page is ready: the old page, and its field, stay on screen until 2900.
 */
const EVENTS: Omit<TimelineEvent, 'stepIndex'>[] = [
  { action: 'navigate', startMs: 0, endMs: 800 },
  {
    action: 'fill',
    startMs: 800,
    endMs: 1400,
    target: { box: FIELD },
    masked: true,
    value: '***',
    maskVisibility: [{ startMs: 800, endMs: 2000, box: FIELD }],
  },
  {
    action: 'click',
    startMs: 1400,
    endMs: 2000,
    target: { box: { x: 580, y: 400, width: 120, height: 40 } },
    pointer: { from: { x: 640, y: 360 }, to: { x: 640, y: 420 } },
  },
  {
    action: 'marker',
    startMs: 2000,
    endMs: 2000,
    marker: { title: 'Dashboard', kind: 'scene' },
  },
  { action: 'waitFor', startMs: 2000, endMs: 3000 },
  { action: 'wait', startMs: 3000, endMs: 5000 },
];

const NAVIGATIONS: Navigation[] = [
  { startMs: 0, endMs: 700 },
  { startMs: 1950, endMs: 2900 },
];

function plan(
  options: RenderPlanOptions & {
    navigations?: Navigation[] | undefined;
    failedAt?: number;
    events?: Omit<TimelineEvent, 'stepIndex'>[];
    maskedElements?: MaskedElement[];
    /** Measures the offset on this mark instead of the fixed `offsetMs: 0`. */
    sync?: { mark: NonNullable<Timeline['syncMark']>; clearMs: number };
  } = {},
): RenderPlan {
  const {
    navigations: given,
    failedAt,
    events = EVENTS,
    maskedElements,
    sync,
    ...rest
  } = options;
  // `navigations: undefined` is a timeline from before #114.
  const navigations = 'navigations' in options ? given : NAVIGATIONS;
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        videoFile: 'source.webm',
        events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
        ...(navigations === undefined ? {} : { navigations }),
        ...(sync === undefined ? {} : { syncMark: sync.mark }),
        ...(maskedElements === undefined ? {} : { maskedElements }),
      },
      result: result(failedAt),
      source: {
        width: 2560,
        height: 1440,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes: [],
      },
      ...(sync === undefined ? {} : { syncClearMs: sync.clearMs }),
    },
    {
      ...(sync === undefined ? { offsetMs: 0 } : {}),
      frame: {},
      cards: cards(true),
      ...rest,
    },
  );
}

function frames(of: RenderPlan): { atMs: number; state: FrameState }[] {
  return Array.from({ length: frameCount(of) }, (_, frame) => ({
    atMs: (frame * 1000) / FPS,
    state: frameAt(of, frame),
  }));
}

/** Every layer a frame draws, itself first. */
function layers(state: FrameState): FrameState[] {
  return state.fade === undefined
    ? [state]
    : [state, ...layers(state.fade.from)];
}

describe('page-load holds (spec 114)', () => {
  it('holds each navigation from its start to its load, then dissolves for 300 ms of page time', () => {
    const holds = plan({ transitions: FADE }).transitions?.holds;
    expect(holds).toEqual([
      // about:blank is never shown: the background from page 0.
      { startMs: 0, endMs: 700, fadeEndMs: 1000, fadeMs: 300, masks: [] },
      {
        // 200 ms before the navigation, at the frame held: the unmeasured
        // offset's lead (#150).
        startMs: 1750,
        // The scene card at 2000 is inside the load: 1 500 ms later.
        endMs: 4400,
        fadeEndMs: 4700,
        fadeMs: 300,
        sourceMs: 1750,
        masks: [MASKED],
      },
    ]);
  });

  it('holds a frame a lead before the start, not the last one before it, so no early-stamped blank frame is held (#150)', () => {
    // A source frame's time can be ~40 ms early (the recorder's 25 fps slots,
    // plus the sync offset's error): the frame just before the start can be
    // the new document's blank page. Unmeasured offset: the 200 ms mask lead.
    const unmeasured = plan({ transitions: FADE });
    const [, held] = unmeasured.transitions?.holds ?? [];
    expect(held.sourceMs).toBe(1950 + unmeasured.offsetMs - 200);
    // The old page still shows the field there: the held frame keeps its mask.
    expect(held.masks).toEqual([MASKED]);

    // Measured offset: the measured mask lead, three source frames (#185),
    // never less than two.
    const measured = plan({
      transitions: FADE,
      sync: { mark: { colour: '#ff00ff', onMs: 25, offMs: 180 }, clearMs: 240 },
    });
    expect(measured.offsetMeasured).toBe(true);
    expect(measured.maskLeadMs).toBe(120);
    const [, measuredHold] = measured.transitions?.holds ?? [];
    expect(measuredHold.sourceMs).toBeCloseTo(
      1950 + measured.offsetMs - 120,
      6,
    );
  });

  it('draws no live frame in the lead before a navigation: the hold starts at the frame held (#150)', () => {
    // The live frames there can already read the new document's blank page.
    const transitioned = plan({ transitions: FADE, cards: cards(false) });
    const [, hold] = transitioned.transitions?.holds ?? [];
    const navigationSourceMs = 1950 + transitioned.offsetMs;
    let live = 0;
    for (const { atMs, state } of frames(transitioned)) {
      for (const layer of layers(state)) {
        if (layer.sourceMs === null || layer.sourceMs === hold.sourceMs) {
          continue;
        }
        live++;
        const inLead =
          layer.sourceMs > (hold.sourceMs ?? Number.NaN) &&
          layer.sourceMs <= navigationSourceMs;
        expect(inLead, `${atMs}: live source ${layer.sourceMs}`).toBe(false);
      }
    }
    expect(live).toBeGreaterThan(0);
  });

  it('never starts a hold before the step before the triggering one, and still holds a frame from before the navigation', () => {
    // A `navigate` at 1900 loads at 1950; the step before it, a 100 ms wait,
    // starts at 1800 — inside the 200 ms lead. The marker takes no time and
    // is no step of its own.
    const transitioned = plan({
      transitions: FADE,
      cards: cards(false),
      events: [
        { action: 'navigate', startMs: 0, endMs: 800 },
        { action: 'wait', startMs: 800, endMs: 1800 },
        { action: 'wait', startMs: 1800, endMs: 1900 },
        {
          action: 'marker',
          startMs: 1900,
          endMs: 1900,
          marker: { title: 'Next', kind: 'scene' },
        },
        { action: 'navigate', startMs: 1900, endMs: 3000 },
        { action: 'wait', startMs: 3000, endMs: 5000 },
      ],
    });
    const [, hold] = transitioned.transitions?.holds ?? [];
    expect(hold.startMs).toBe(1800);
    expect(hold.sourceMs).toBe(1950 + transitioned.offsetMs - 200);
  });

  it('shows the background, never the blank page, until the first load, then dissolves into the page', () => {
    for (const { atMs, state } of frames(plan({ transitions: FADE }))) {
      if (atMs < 700) {
        expect(state.backdrop, `${atMs}`).toBeDefined();
        expect(state.sourceMs).toBeNull();
      } else if (atMs < 1000) {
        expect(state.sourceMs).not.toBeNull();
        expect(state.fade?.from.backdrop).toBeDefined();
        expect(state.fade?.progress).toBeCloseTo((atMs - 700) / 300, 6);
      } else {
        break;
      }
    }
  });

  it('draws the mask active when the navigation starts on every held and dissolving frame', () => {
    const transitioned = plan({ transitions: FADE });
    const [, hold] = transitioned.transitions?.holds ?? [];
    let held = 0;
    for (const { atMs, state } of frames(transitioned)) {
      if (atMs < hold.startMs || atMs >= hold.fadeEndMs) continue;
      const heldLayers = layers(state).filter(
        (layer) => layer.sourceMs === hold.sourceMs,
      );
      // A card frame between draws no page; every other frame draws the held one.
      if (state.card === undefined || state.fade !== undefined) {
        expect(heldLayers.length, `${atMs}`).toBeGreaterThan(0);
      }
      for (const layer of heldLayers) {
        expect(layer.masks.length, `${atMs}`).toBe(1);
        held++;
      }
    }
    // 1 450 ms of page frames and 600 ms of card dissolves: 61 frames.
    expect(held).toBe(61);
    // The live page's own mask ended with the hold's start: after the hold, none.
    expect(frameAt(transitioned, Math.ceil((4500 * FPS) / 1000)).masks).toEqual(
      [],
    );
  });

  it('draws the held frame under the live cursor and rings', () => {
    const transitioned = plan({ transitions: FADE });
    const plain = plan();
    // Frame 59, 1 966 ms: the click's ring is under way on the held frame.
    const frame = 59;
    const state = frameAt(transitioned, frame);
    expect(state.sourceMs).toBe(1750);
    expect(state.cursor).toEqual(frameAt(plain, frame).cursor);
    expect(state.rings).toEqual(frameAt(plain, frame).rings);
  });

  it('holds an open navigation until the next step starts', () => {
    const holds = plan({
      transitions: FADE,
      navigations: [{ startMs: 0, endMs: 700 }, { startMs: 1950 }],
    }).transitions?.holds;
    // The marker at 2 000 is the next step; the card on that cut comes first.
    expect(holds?.[1]).toMatchObject({ startMs: 1750, endMs: 3500 });
  });

  it('holds no navigation the page never reached after a failure', () => {
    const holds = plan({ transitions: FADE, failedAt: 1 }).transitions?.holds;
    expect(holds?.map((hold) => hold.startMs)).toEqual([0]);
  });
});

describe('card dissolves (spec 114)', () => {
  const scene = (of: RenderPlan) => {
    const card = of.cards.find((entry) => entry.kind === 'scene');
    if (card === undefined) throw new Error('no scene card');
    return card;
  };

  it("dissolves a scene card's first and last 300 ms with the page, inside its own time", () => {
    const transitioned = plan({ transitions: FADE, navigations: undefined });
    const card = scene(transitioned);
    const endMs = card.startMs + card.durationMs;
    let fading = 0;
    for (const { atMs, state } of frames(transitioned)) {
      if (atMs < card.startMs || atMs >= endMs) continue;
      expect(state.card?.title).toBe('Dashboard');
      if (atMs < card.startMs + 300) {
        expect(state.fade?.progress).toBeCloseTo(
          (atMs - card.startMs) / 300,
          6,
        );
        expect(state.fade?.from.sourceMs).not.toBeNull();
        fading++;
      } else if (atMs >= endMs - 300) {
        expect(state.fade?.progress).toBeCloseTo((endMs - atMs) / 300, 6);
        expect(state.fade?.from.sourceMs).not.toBeNull();
        fading++;
      } else {
        expect(state.fade).toBeUndefined();
      }
    }
    expect(fading).toBe(18);
    expect(transitioned.durationMs).toBe(plan().durationMs);
  });

  it('leaves every page frame as #108 drew it', () => {
    const transitioned = plan({ transitions: FADE, navigations: undefined });
    const plain = plan({ navigations: undefined });
    const card = scene(plain);
    for (const [frame, { atMs, state }] of frames(transitioned).entries()) {
      const before = frameAt(plain, frame);
      if (atMs >= card.startMs && atMs < card.startMs + card.durationMs) {
        const { fade: _, ...rest } = state;
        expect(rest).toEqual(before);
      } else {
        expect(state).toEqual(before);
      }
    }
  });

  it('dissolves the scene card from and into the held frame of the load it is in', () => {
    const transitioned = plan({ transitions: FADE });
    const card = scene(transitioned);
    const at = (ms: number) =>
      frameAt(transitioned, Math.ceil((ms * FPS) / 1000));
    for (const ms of [
      card.startMs + 100,
      card.startMs + card.durationMs - 100,
    ]) {
      const from = at(ms).fade?.from;
      expect(from?.sourceMs).toBe(1750);
      expect(from?.masks).toHaveLength(1);
    }
  });

  it('dissolves the intro only out, into the background of the first load', () => {
    const transitioned = plan({
      transitions: FADE,
      cards: { ...cards(false), intro: { enabled: true, durationMs: 2000 } },
    });
    expect(frameAt(transitioned, 0).fade).toBeUndefined();
    const out = frameAt(transitioned, Math.round((1900 * FPS) / 1000));
    expect(out.card?.title).toBe('Sign in');
    expect(out.fade?.from.backdrop).toBeDefined();
  });
});

describe('a masked field across a document navigation (spec 146)', () => {
  const NO_CARDS = { cards: cards(false) };
  const OFF = { ...NO_CARDS, transitions: { enabled: false, durationMs: 300 } };
  const ON = { ...NO_CARDS, transitions: FADE };
  const LEAD_TRAIL_MS = 200;
  const [, LOGIN] = NAVIGATIONS;
  const LOGIN_END_MS = (LOGIN.endMs ?? 0) + LEAD_TRAIL_MS;

  const fill = EVENTS[1];
  /** The field measured as still there when the load is under way: the end of the `waitFor`. */
  const LATE: typeof EVENTS = EVENTS.map((event) =>
    event === fill
      ? {
          ...event,
          maskVisibility: [{ startMs: 800, endMs: 3000, box: FIELD }],
        }
      : event,
  );
  /** A timeline from before `maskVisibility` (#18): the landing video's shape. */
  const UNMEASURED: typeof EVENTS = EVENTS.map((event) => {
    if (event !== fill) return event;
    const { maskVisibility: _, ...rest } = event;
    return rest;
  });
  const SHAPES = { measured: EVENTS, late: LATE, unmeasured: UNMEASURED };

  /** Every frame from `fromMs` on draws no mask on the live page. */
  function expectNoLiveMask(of: RenderPlan, fromMs: number): void {
    const heldMs = of.transitions?.holds[1]?.sourceMs;
    let checked = 0;
    for (const { atMs, state } of frames(of)) {
      if (atMs < fromMs) continue;
      for (const layer of layers(state)) {
        if (layer.sourceMs === heldMs || layer.sourceMs === null) continue;
        expect(layer.masks, `${atMs}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }

  for (const [shape, events] of Object.entries(SHAPES)) {
    it(`draws no live-page mask once the hold shows the old page, transitions on (${shape})`, () => {
      const transitioned = plan({ ...ON, events });
      const [, hold] = transitioned.transitions?.holds ?? [];
      expect(transitioned.masks.map((mask) => mask.endMs)).toEqual([
        LOGIN.startMs,
      ]);
      // The held frame keeps the hold's mask, as #114 drew it.
      expect(hold.masks).toEqual([MASKED]);
      expectNoLiveMask(transitioned, hold.startMs);
    });

    it(`masks every frame of the old page until the new one loads, then none, transitions off (${shape})`, () => {
      const plain = plan({ ...OFF, events });
      expect(plain.masks.map((mask) => mask.endMs)).toEqual([LOGIN_END_MS]);
      for (const { atMs, state } of frames(plain)) {
        if (atMs < 800 - LEAD_TRAIL_MS) continue;
        if (atMs >= LOGIN_END_MS) break;
        expect(state.masks, `${atMs}`).toHaveLength(1);
      }
      expectNoLiveMask(plain, LOGIN_END_MS);
    });

    it(`keeps today's span for a same-document route change (${shape})`, () => {
      // A pushState has no entry in `navigations`: only the first load is there.
      for (const options of [ON, OFF]) {
        expect(
          plan({ ...options, events, navigations: [NAVIGATIONS[0]] }).masks,
        ).toEqual(plan({ ...options, events, navigations: undefined }).masks);
      }
    });
  }

  it('plans exactly what it planned before for a timeline without navigations', () => {
    for (const options of [ON, OFF]) {
      const before = plan({ ...options, navigations: undefined });
      expect(before.masks).toEqual([
        { startMs: 600, endMs: 2200, keys: [{ atMs: 600, box: MASKED }] },
      ]);
      expect(
        plan({ ...options, events: UNMEASURED, navigations: undefined }).masks,
      ).toEqual([
        { startMs: 600, endMs: 6000, keys: [{ atMs: 600, box: MASKED }] },
      ]);
    }
  });

  it('keeps an open navigation to today’s span with transitions off', () => {
    const open = [NAVIGATIONS[0], { startMs: LOGIN.startMs }];
    expect(plan({ ...OFF, navigations: open }).masks[0].endMs).toBe(2200);
    expect(plan({ ...ON, navigations: open }).masks[0].endMs).toBe(
      LOGIN.startMs,
    );
  });

  it('never ends a span on the load that starts as its field is measured', () => {
    // The load at 800 brings in the page the field is measured on; the login's ends it.
    const navigations = [NAVIGATIONS[0], { startMs: 800, endMs: 850 }, LOGIN];
    expect(plan({ ...OFF, navigations }).masks[0].endMs).toBe(LOGIN_END_MS);
  });

  it('keeps the measured spans of a field the navigation left on screen', () => {
    const MOVED = { x: 200, y: 300, width: 320, height: 60 };
    const stays: typeof EVENTS = EVENTS.map((event) =>
      event === fill
        ? {
            ...event,
            maskVisibility: [
              { startMs: 800, endMs: 2000, box: FIELD },
              { startMs: 1990, box: MOVED },
            ],
          }
        : event,
    );
    for (const options of [ON, OFF]) {
      expect(plan({ ...options, events: stays }).masks).toEqual(
        plan({ ...options, events: stays, navigations: undefined }).masks,
      );
    }
  });
});

describe('a marked element across a document navigation (#221)', () => {
  const NO_CARDS = { cards: cards(false) };
  const OFF = { ...NO_CARDS, transitions: { enabled: false, durationMs: 300 } };
  const ON = { ...NO_CARDS, transitions: FADE };
  const LEAD_TRAIL_MS = 200;
  const [FIRST, LOGIN] = NAVIGATIONS;
  /** The sign-in with no masked fill: only the marked element is masked. */
  const UNFILLED: typeof EVENTS = EVENTS.map((event) =>
    event === EVENTS[1]
      ? { action: 'wait', startMs: event.startMs, endMs: event.endMs }
      : event,
  );
  const marked = (startMs: number, endMs?: number): MaskedElement[] => [
    {
      intervals: [
        endMs === undefined
          ? { startMs, box: FIELD }
          : { startMs, endMs, box: FIELD },
      ],
    },
  ];

  it('never ends a span on the load that brought its document in, when its start maps a few ms early', () => {
    // The engine maps a start by the bound that errs early: here 10 ms before the load's request.
    const cases: Array<{
      navigations: Navigation[];
      maskedElements: MaskedElement[];
    }> = [
      // The first load: not held, so the span ended at its load plus the trail.
      {
        navigations: [{ ...FIRST, startMs: 100 }, LOGIN],
        maskedElements: marked(90),
      },
      // The sign-in's load: held with transitions on, so the span ended at its start.
      { navigations: NAVIGATIONS, maskedElements: marked(LOGIN.startMs - 10) },
      {
        navigations: NAVIGATIONS,
        maskedElements: marked(LOGIN.startMs - 10, 4000),
      },
    ];
    for (const options of [ON, OFF]) {
      for (const { navigations, maskedElements } of cases) {
        const planned = plan({
          ...options,
          events: UNFILLED,
          navigations,
          maskedElements,
        });
        expect(planned.masks).toEqual(
          plan({
            ...options,
            events: UNFILLED,
            navigations: undefined,
            maskedElements,
          }).masks,
        );
      }
    }
  });

  it('masks an element of the old page until the new one loads, transitions off', () => {
    const planned = plan({
      ...OFF,
      events: UNFILLED,
      maskedElements: marked(800, 2000),
    });
    expect(planned.masks.map((mask) => mask.endMs)).toEqual([
      (LOGIN.endMs ?? 0) + LEAD_TRAIL_MS,
    ]);
  });

  it('masks an element of the old page on the held frame, and never ends its span before its measured end', () => {
    const planned = plan({
      ...ON,
      events: UNFILLED,
      maskedElements: marked(800, 2000),
    });
    expect(planned.masks.map((mask) => mask.endMs)).toEqual([
      2000 + LEAD_TRAIL_MS,
    ]);
    const [, hold] = planned.transitions?.holds ?? [];
    expect(hold.masks).toEqual([MASKED]);
  });
});

describe('transitions off', () => {
  it('plans exactly what #108 planned', () => {
    expect(plan({ transitions: { enabled: false, durationMs: 300 } })).toEqual(
      plan(),
    );
    expect(plan().transitions).toBeUndefined();
  });
});
