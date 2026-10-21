import {
  type CardsConfig,
  deriveRunStatus,
  type Navigation,
  type RunResult,
  type Stages,
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
 * password's field leaves with the navigation: its mask ends at the click's
 * end plus the trail, long before the new page is ready.
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
  } = {},
): RenderPlan {
  const { navigations: given, failedAt, ...rest } = options;
  // `navigations: undefined` is a timeline from before #114.
  const navigations = 'navigations' in options ? given : NAVIGATIONS;
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        videoFile: 'source.webm',
        events: EVENTS.map((event, stepIndex) => ({ ...event, stepIndex })),
        ...(navigations === undefined ? {} : { navigations }),
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
    },
    { offsetMs: 0, frame: {}, cards: cards(true), ...rest },
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
        startMs: 1950,
        // The scene card at 2000 is inside the load: 1 500 ms later.
        endMs: 4400,
        fadeEndMs: 4700,
        fadeMs: 300,
        sourceMs: 1949,
        masks: [MASKED],
      },
    ]);
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
    // 1 250 ms of page frames and 600 ms of card dissolves: 55 frames.
    expect(held).toBe(55);
    // The live page's own mask ended at 2 200: after the hold, none.
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
    expect(state.sourceMs).toBe(1949);
    expect(state.cursor).toEqual(frameAt(plain, frame).cursor);
    expect(state.rings).toEqual(frameAt(plain, frame).rings);
  });

  it('holds an open navigation until the next step starts', () => {
    const holds = plan({
      transitions: FADE,
      navigations: [{ startMs: 0, endMs: 700 }, { startMs: 1950 }],
    }).transitions?.holds;
    // The marker at 2 000 is the next step; the card on that cut comes first.
    expect(holds?.[1]).toMatchObject({ startMs: 1950, endMs: 3500 });
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
      expect(from?.sourceMs).toBe(1949);
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

describe('transitions off', () => {
  it('plans exactly what #108 planned', () => {
    expect(plan({ transitions: { enabled: false, durationMs: 300 } })).toEqual(
      plan(),
    );
    expect(plan().transitions).toBeUndefined();
  });
});
