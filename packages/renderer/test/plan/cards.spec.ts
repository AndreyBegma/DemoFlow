import {
  type CardsConfig,
  deriveRunStatus,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_PRESET_COLOURS,
  cameraAt,
  frameAt,
  frameCount,
  insertCards,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
  toOutputMs,
  toSourceMs,
} from '../../src/index.ts';

const VIEWPORT = { width: 1280, height: 720 };
/** Output frames per card at 30 fps: every card duration here is a whole number of them. */
const FPS = 30;

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
    scenarioName: 'Create a customer',
    startedAt: '2026-10-18T10:00:00.000Z',
    finishedAt: '2026-10-18T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

/** Every card off unless a test turns it on, so each test reads one kind. */
function cards(overrides: Partial<CardsConfig> = {}): CardsConfig {
  return {
    intro: { enabled: false, durationMs: 2000 },
    scenes: { enabled: false, durationMs: 1500 },
    outro: { durationMs: 2500 },
    ...overrides,
  };
}

const SCENES_ON = { scenes: { enabled: true, durationMs: 1500 } };

function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  options: RenderPlanOptions & { failedAt?: number } = {},
): RenderPlan {
  const { failedAt, ...rest } = options;
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        videoFile: 'source.webm',
        events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
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
    { offsetMs: 0, frame: {}, ...rest },
  );
}

function click(
  startMs: number,
  endMs: number,
  centre: { x: number; y: number },
): Omit<TimelineEvent, 'stepIndex'> {
  return {
    action: 'click',
    startMs,
    endMs,
    target: {
      box: { x: centre.x - 60, y: centre.y - 14, width: 120, height: 28 },
    },
    pointer: { from: { x: 640, y: 360 }, to: centre },
  };
}

function scene(atMs: number, title: string): Omit<TimelineEvent, 'stepIndex'> {
  return {
    action: 'marker',
    startMs: atMs,
    endMs: atMs,
    marker: { title, kind: 'scene' },
  };
}

/** The frames of `plain` and `carded` agree once every card before is skipped. */
function expectPageFramesShifted(plain: RenderPlan, carded: RenderPlan): void {
  const frames = frameCount(plain);
  for (let f = 0; f < frames; f++) {
    const atMs = (f * 1000) / FPS;
    const before = carded.cards.filter((card) => {
      const cutMs = card.startMs - shiftBefore(carded, card.startMs);
      return cutMs <= atMs;
    });
    const skipped = before.reduce((sum, card) => sum + card.durationMs, 0);
    const g = f + Math.round((skipped * FPS) / 1000);
    expect(rounded(frameAt(carded, g)), `page frame ${f} → ${g}`).toEqual(
      rounded(frameAt(plain, f)),
    );
  }
}

/** Every number to a millionth: a map cut in two interpolates in a different order. */
function rounded<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v: unknown) =>
      typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v,
    ),
  ) as T;
}

/** The card time before output `atMs`. */
function shiftBefore(rendered: RenderPlan, atMs: number): number {
  return rendered.cards
    .filter((card) => card.startMs < atMs)
    .reduce((sum, card) => sum + card.durationMs, 0);
}

function zoomAt(rendered: RenderPlan, atMs: number): number {
  return VIEWPORT.width / cameraAt(rendered, atMs).width;
}

describe('cards (spec 108)', () => {
  // Off the 30 fps frame grid, so no instant sits on a frame's float edge.
  const EVENTS = [
    click(510, 1010, { x: 300, y: 200 }),
    scene(3000, 'Invoices'),
    click(4010, 4610, { x: 900, y: 500 }),
  ];

  it('renders none without `options.cards`, as before', () => {
    const rendered = plan(EVENTS);
    expect(rendered.cards).toEqual([]);
    expect(rendered.timeMap.every((s) => s.sourceEndMs > s.sourceStartMs)).toBe(
      true,
    );
    expect(rendered.cardBackground).toEqual(BACKGROUND_PRESET_COLOURS.ocean);
  });

  describe('intro', () => {
    const intro = { intro: { enabled: true, durationMs: 2000 } };

    it('shows the scenario name and description before the first page frame', () => {
      const rendered = plan(EVENTS, {
        cards: cards(intro),
        scenario: { description: 'From the dashboard to a saved record' },
      });
      expect(rendered.cards).toEqual([
        {
          kind: 'intro',
          startMs: 0,
          durationMs: 2000,
          title: 'Create a customer',
          subtitle: 'From the dashboard to a saved record',
        },
      ]);
      const first = frameAt(rendered, 0);
      expect(first.sourceMs).toBeNull();
      expect(first.card).toEqual({
        title: 'Create a customer',
        subtitle: 'From the dashboard to a saved record',
        background: BACKGROUND_PRESET_COLOURS.ocean,
      });
      expect(first.cursor).toBeUndefined();
      expect(first.masks).toEqual([]);
      expect(frameAt(rendered, (2000 * FPS) / 1000 - 1).card).toBeDefined();
      expect(frameAt(rendered, (2000 * FPS) / 1000).card).toBeUndefined();
    });

    it('has no subtitle without a description, or with a blank one', () => {
      for (const scenario of [{}, { description: '  ' }]) {
        const rendered = plan(EVENTS, { cards: cards(intro), scenario });
        expect(rendered.cards[0]).not.toHaveProperty('subtitle');
      }
    });

    it('makes the video exactly its duration longer, every page frame shifted', () => {
      const plain = plan(EVENTS, { cards: cards() });
      const carded = plan(EVENTS, { cards: cards(intro) });
      expect(carded.durationMs).toBe(plain.durationMs + 2000);
      expect(frameCount(carded)).toBe(frameCount(plain) + 60);
      expectPageFramesShifted(plain, carded);
    });

    it('is drawn on the background even with the frame off', () => {
      const rendered = plan(EVENTS, {
        cards: cards(intro),
        frame: { enabled: false },
        background: { preset: 'paper' },
      });
      expect(rendered.frame).toBeUndefined();
      expect(frameAt(rendered, 0).card?.background).toEqual(
        BACKGROUND_PRESET_COLOURS.paper,
      );
    });
  });

  describe('scene', () => {
    it('inserts a card on the marker: the page pauses on the cut and resumes there', () => {
      const plain = plan(EVENTS, { cards: cards() });
      const carded = plan(EVENTS, { cards: cards(SCENES_ON) });
      expect(carded.cards).toEqual([
        { kind: 'scene', startMs: 3000, durationMs: 1500, title: 'Invoices' },
      ]);
      expect(carded.durationMs).toBe(plain.durationMs + 1500);
      // The card is a segment of the map with no source span: the held frame.
      expect(carded.timeMap).toContainEqual({
        outputStartMs: 3000,
        outputEndMs: 4500,
        sourceStartMs: 3000,
        sourceEndMs: 3000,
      });
      expect(toSourceMs(carded.timeMap, 3500)).toBe(3000);
      expect(toOutputMs(carded.timeMap, 3000)).toBe(4500);
      // The page frame just before the card and the one just after it.
      const cut = (3000 * FPS) / 1000;
      expect(rounded(frameAt(carded, cut - 1))).toEqual(
        rounded(frameAt(plain, cut - 1)),
      );
      expect(rounded(frameAt(carded, cut + 45))).toEqual(
        rounded(frameAt(plain, cut)),
      );
      expectPageFramesShifted(plain, carded);
    });

    it('keeps the cursor and a later click ring on the page they were on', () => {
      const plain = plan(EVENTS, { cards: cards() });
      const carded = plan(EVENTS, { cards: cards(SCENES_ON) });
      expect(carded.clicks[0]).toEqual(plain.clicks[0]);
      expect(carded.clicks[1]).toEqual({
        ...plain.clicks[1],
        atMs: plain.clicks[1].atMs + 1500,
      });
      const ring = (rendered: RenderPlan, atMs: number) =>
        frameAt(rendered, Math.round((atMs * FPS) / 1000));
      const after = ring(carded, carded.clicks[1].atMs + 100);
      const without = ring(plain, plain.clicks[1].atMs + 100);
      expect(after.rings).toEqual(without.rings);
      expect(after.cursor).toEqual(without.cursor);
    });

    it('holds a zoom-out under way at the cut through the card', () => {
      // The zoom-out after the press (2 500 → 2 900 ms) is cut halfway, at 2 700.
      const events = [
        { ...click(2000, 2600, { x: 300, y: 200 }), zoom: true },
        scene(2700, 'Invoices'),
        { ...click(6000, 6600, { x: 900, y: 500 }), zoom: true },
      ];
      const carded = plan(events, { cards: cards(SCENES_ON) });
      const plain = plan(events, { cards: cards() });
      const atCut = zoomAt(plain, 2700);
      // Halfway out of 1.35× on the 2× source.
      expect(atCut).toBeCloseTo(1.175, 3);
      // It eases into the cut and out of it: the same zoom on both sides.
      expect(zoomAt(carded, 2700 - 1)).toBeCloseTo(atCut, 3);
      expect(zoomAt(carded, 2700 + 1500)).toBeCloseTo(atCut, 6);
      // …and finishes after the card when it would have without it.
      expect(zoomAt(carded, 2900 + 1500)).toBeCloseTo(1, 6);
      // On the card itself nothing of the page is drawn.
      expect(frameAt(carded, (3000 * FPS) / 1000).card).toBeDefined();
    });

    it('drops a marker after a failure: the page never got there', () => {
      const rendered = plan(
        [
          click(500, 1000, { x: 300, y: 200 }),
          scene(1500, 'Before'),
          click(2000, 2600, { x: 900, y: 500 }),
          scene(3000, 'After'),
        ],
        { cards: cards(SCENES_ON), failedAt: 2 },
      );
      expect(rendered.cards.map((card) => card.title)).toEqual(['Before']);
    });

    it('turned off, renders no card on a marker', () => {
      const rendered = plan(EVENTS, {
        cards: cards({ scenes: { enabled: false, durationMs: 1500 } }),
      });
      expect(rendered.cards).toEqual([]);
    });
  });

  describe('a mask across a card', () => {
    const password = { x: 400, y: 300, width: 240, height: 40 };
    const fill = (endMs: number): Omit<TimelineEvent, 'stepIndex'> => ({
      action: 'fill',
      startMs: 600,
      endMs: 1200,
      target: { box: password },
      masked: true,
      value: '***',
      maskVisibility: [{ startMs: 600, endMs, box: password }],
    });

    it('is applied to the page frames on both sides of the card', () => {
      const events = [
        fill(5000),
        scene(3000, 'Invoices'),
        click(5500, 6000, { x: 900, y: 500 }),
      ];
      const plain = plan(events, { cards: cards() });
      const carded = plan(events, { cards: cards(SCENES_ON) });
      const cut = (3000 * FPS) / 1000;
      const before = frameAt(carded, cut - 1);
      const after = frameAt(carded, cut + 45);
      expect(before.masks).toHaveLength(1);
      expect(after.masks).toEqual(before.masks);
      expect(frameAt(carded, cut).masks).toEqual([]);
      expectPageFramesShifted(plain, carded);
    });

    it('keeps its trail after the card when the field left just before the cut', () => {
      // The field leaves at 2 950; the 200 ms trail runs past the cut at 3 000.
      const events = [fill(2950), scene(3000, 'Invoices')];
      const plain = plan(events, { cards: cards() });
      const carded = plan(events, { cards: cards(SCENES_ON) });
      const cut = (3000 * FPS) / 1000;
      expect(frameAt(plain, cut).masks).toHaveLength(1);
      expect(frameAt(carded, cut + 45).masks).toEqual(
        frameAt(plain, cut).masks,
      );
      expectPageFramesShifted(plain, carded);
    });

    it('moves with a scroll on both sides of a card', () => {
      const events: Omit<TimelineEvent, 'stepIndex'>[] = [
        fill(8000),
        {
          action: 'scroll',
          startMs: 2000,
          endMs: 2600,
          scroll: { before: { x: 0, y: 0 }, after: { x: 0, y: 120 } },
        },
        scene(3000, 'Invoices'),
        click(6000, 6600, { x: 900, y: 500 }),
      ];
      const plain = plan(events, { cards: cards() });
      const carded = plan(events, { cards: cards(SCENES_ON) });
      expectPageFramesShifted(plain, carded);
    });
  });

  describe('outro', () => {
    const outro = {
      outro: { title: 'Acme', cta: 'acme.dev/try', durationMs: 2500 },
    };

    it('follows the last page frame with the title and the call to action', () => {
      const plain = plan(EVENTS, { cards: cards() });
      const rendered = plan(EVENTS, { cards: cards(outro) });
      expect(rendered.cards).toEqual([
        {
          kind: 'outro',
          startMs: plain.durationMs,
          durationMs: 2500,
          title: 'Acme',
          subtitle: 'acme.dev/try',
        },
      ]);
      expect(rendered.durationMs).toBe(plain.durationMs + 2500);
      const last = frameCount(rendered) - 1;
      expect(frameAt(rendered, last).card?.title).toBe('Acme');
      expectPageFramesShifted(plain, rendered);
    });

    it('is not rendered without a title', () => {
      const rendered = plan(EVENTS, {
        cards: cards({ outro: { durationMs: 2500 } }),
      });
      expect(rendered.cards).toEqual([]);
    });

    it('is not rendered on a failed run: the failure card ends it, cards before stay', () => {
      const rendered = plan(
        [
          click(500, 1000, { x: 300, y: 200 }),
          scene(1500, 'Before'),
          click(2000, 2600, { x: 900, y: 500 }),
        ],
        {
          cards: cards({
            intro: { enabled: true, durationMs: 2000 },
            ...SCENES_ON,
            ...outro,
          }),
          failedAt: 2,
        },
      );
      expect(rendered.cards.map((card) => card.kind)).toEqual([
        'intro',
        'scene',
      ]);
      const pageEndMs = rendered.timeMap.at(-1)?.outputEndMs ?? 0;
      expect(rendered.failure?.endCard.startMs).toBe(pageEndMs);
      expect(rendered.durationMs).toBe(pageEndMs + 3000);
      // The FAILED watermark is on every frame, the cards included.
      expect(frameAt(rendered, 0).watermark).toBe(true);
    });
  });
});

describe('insertCards', () => {
  const MAP = [
    {
      outputStartMs: 0,
      outputEndMs: 1000,
      sourceStartMs: 0,
      sourceEndMs: 1000,
    },
    // An idle stretch played fast.
    {
      outputStartMs: 1000,
      outputEndMs: 1400,
      sourceStartMs: 1000,
      sourceEndMs: 4000,
    },
  ];

  it('cuts a segment on the card and holds the frame there', () => {
    expect(insertCards(MAP, [{ atMs: 1200, durationMs: 500 }])).toEqual([
      MAP[0],
      {
        outputStartMs: 1000,
        outputEndMs: 1200,
        sourceStartMs: 1000,
        sourceEndMs: 2500,
      },
      {
        outputStartMs: 1200,
        outputEndMs: 1700,
        sourceStartMs: 2500,
        sourceEndMs: 2500,
      },
      {
        outputStartMs: 1700,
        outputEndMs: 1900,
        sourceStartMs: 2500,
        sourceEndMs: 4000,
      },
    ]);
  });

  it('puts cards at the start, on a boundary and past the end', () => {
    const map = insertCards(MAP, [
      { atMs: 0, durationMs: 100 },
      { atMs: 1000, durationMs: 100 },
      { atMs: 1400, durationMs: 100 },
    ]);
    expect(
      map.map((s) => [s.outputStartMs, s.sourceStartMs, s.sourceEndMs]),
    ).toEqual([
      [0, 0, 0],
      [100, 0, 1000],
      [1100, 1000, 1000],
      [1200, 1000, 4000],
      [1600, 4000, 4000],
    ]);
    expect(map.at(-1)?.outputEndMs).toBe(1700);
    // Source time on a cut maps past its card; the ends clamp to the page.
    expect(toOutputMs(map, 0)).toBe(100);
    expect(toOutputMs(map, 1000)).toBe(1200);
    expect(toOutputMs(map, 4000)).toBe(1600);
  });
});
