import { describe, expect, it } from 'vitest';
import {
  checkRunEdits,
  deriveRunStatus,
  type RunEdits,
  RunEditsSchema,
  type RunResult,
  type Stages,
  type Timeline,
  TimelineSchema,
} from '../src/index.ts';

const timeline: Timeline = TimelineSchema.parse({
  schemaVersion: 1,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
  videoFile: 'source.webm',
  events: [
    { stepIndex: 0, action: 'navigate', startMs: 0, endMs: 800 },
    {
      stepIndex: 1,
      action: 'click',
      startMs: 800,
      endMs: 1400,
      target: { box: { x: 100, y: 200, width: 80, height: 32 } },
    },
    { stepIndex: 2, action: 'wait', startMs: 1400, endMs: 2400, holdMs: 500 },
  ],
});

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
    scenarioName: 'Sign up',
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

const caption = (startMs: number, endMs: number, text = 'Hello') => ({
  startMs,
  endMs,
  text,
});

const cut = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('RunEditsSchema', () => {
  it('parses a minimal file', () => {
    expect(RunEditsSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
  });

  it('parses every kind of edit', () => {
    const edits = {
      schemaVersion: 1,
      captions: [caption(0, 500), caption(500, 900, 'Next')],
      zoom: [
        { stepIndex: 1, zoom: 2 },
        { stepIndex: 3, zoom: false },
      ],
      cards: {
        intro: { enabled: true, title: 'Sign up', subtitle: null },
        scenes: { enabled: false },
        outro: { title: 'Try it', cta: 'example.com' },
      },
      background: { color: '#112233' },
      frame: { enabled: true, radius: 0, shadow: false },
      trim: { startMs: 200, endMs: 2_000 },
      cuts: [cut(300, 400), cut(401, 900)],
    };
    expect(RunEditsSchema.parse(edits)).toEqual(edits);
  });

  it('trims caption text', () => {
    const edits = RunEditsSchema.parse({
      schemaVersion: 1,
      captions: [caption(0, 10, '  Hi  ')],
    });
    expect(edits.captions?.[0]?.text).toBe('Hi');
  });

  it.each([
    ['an unknown key', { schemaVersion: 1, speed: 2 }],
    ['schemaVersion 2', { schemaVersion: 2 }],
    ['an empty caption span', { captions: [caption(100, 100)] }],
    ['a caption ending before it starts', { captions: [caption(100, 50)] }],
    [
      'overlapping captions',
      { captions: [caption(0, 200), caption(100, 300)] },
    ],
    ['unordered captions', { captions: [caption(500, 600), caption(0, 100)] }],
    [
      '201 captions',
      {
        captions: Array.from({ length: 201 }, (_, index) =>
          caption(index * 10, index * 10 + 5),
        ),
      },
    ],
    [
      'a 121-character caption',
      { captions: [caption(0, 10, 'x'.repeat(121))] },
    ],
    ['a blank caption', { captions: [caption(0, 10, '   ')] }],
    ['a fractional time', { captions: [caption(0.5, 10)] }],
    [
      'a duplicate stepIndex',
      {
        zoom: [
          { stepIndex: 1, zoom: true },
          { stepIndex: 1, zoom: false },
        ],
      },
    ],
    ['zoom 4', { zoom: [{ stepIndex: 1, zoom: 4 }] }],
    ['an outro without title', { cards: { outro: { cta: 'example.com' } } }],
    [
      'an 81-character card title',
      { cards: { intro: { title: 'x'.repeat(81) } } },
    ],
    ['a negative frame radius', { frame: { radius: -1 } }],
    ['a frame margin', { frame: { marginRatio: 0.1 } }],
    ['an image background', { background: { image: 'a.png' } }],
    ['a trim ending at its start', { trim: { startMs: 500, endMs: 500 } }],
    ['a trim ending before its start', { trim: { startMs: 500, endMs: 400 } }],
    ['an empty cut', { cuts: [cut(100, 100)] }],
    ['unordered cuts', { cuts: [cut(500, 600), cut(0, 100)] }],
    ['overlapping cuts', { cuts: [cut(0, 200), cut(100, 300)] }],
    ['touching cuts', { cuts: [cut(0, 200), cut(200, 300)] }],
    [
      '101 cuts',
      {
        cuts: Array.from({ length: 101 }, (_, index) =>
          cut(index * 10, index * 10 + 5),
        ),
      },
    ],
  ])('rejects %s', (_, edits) => {
    expect(
      RunEditsSchema.safeParse({ schemaVersion: 1, ...edits }).success,
    ).toBe(false);
  });

  it('accepts a trim with one end, and 100 cuts', () => {
    const cuts = Array.from({ length: 100 }, (_, index) =>
      cut(index * 10, index * 10 + 5),
    );
    for (const edits of [
      { trim: { startMs: 500 } },
      { trim: { endMs: 500 } },
      { trim: {} },
      { cuts },
    ]) {
      expect(
        RunEditsSchema.safeParse({ schemaVersion: 1, ...edits }).success,
      ).toBe(true);
    }
  });

  it('accepts 200 captions', () => {
    const captions = Array.from({ length: 200 }, (_, index) =>
      caption(index * 10, index * 10 + 5),
    );
    expect(
      RunEditsSchema.safeParse({ schemaVersion: 1, captions }).success,
    ).toBe(true);
  });
});

describe('checkRunEdits', () => {
  const check = (
    edits: Omit<RunEdits, 'schemaVersion'>,
    tailMs?: number,
    failedAt?: number,
  ) =>
    checkRunEdits(
      RunEditsSchema.parse({ schemaVersion: 1, ...edits }),
      timeline,
      result(failedAt),
      tailMs === undefined ? {} : { tailMs },
    );

  it('accepts a zoom on a click with a box', () => {
    expect(check({ zoom: [{ stepIndex: 1, zoom: true }] })).toEqual([]);
  });

  it('reports zoom-no-target for a wait step and for a step not in the timeline', () => {
    expect(
      check({
        zoom: [
          { stepIndex: 2, zoom: true },
          { stepIndex: 1, zoom: false },
          { stepIndex: 9, zoom: 2 },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        path: 'zoom[0].stepIndex',
        code: 'zoom-no-target',
      }),
      expect.objectContaining({
        path: 'zoom[2].stepIndex',
        code: 'zoom-no-target',
      }),
    ]);
  });

  it('lets a caption reach the end hold after the last event and its hold', () => {
    // The last event ends at 2400, holds 500, and the default tail is 2500.
    expect(check({ captions: [caption(0, 5_400)] })).toEqual([]);
    expect(check({ captions: [caption(0, 5_401)] })).toEqual([
      expect.objectContaining({
        path: 'captions[0].endMs',
        code: 'caption-out-of-range',
      }),
    ]);
  });

  it('measures the tail the renderer keeps', () => {
    expect(check({ captions: [caption(0, 3_000)] }, 0)).toEqual([
      expect.objectContaining({ code: 'caption-out-of-range' }),
    ]);
    expect(check({ captions: [caption(0, 2_900)] }, 0)).toEqual([]);
  });

  describe('trim and cuts', () => {
    // The run's range: 0 to 5400 (the last event ends at 2400, holds 500,
    // and the default tail is 2500); to 1400 when the click at step 1 fails.
    it('accepts a cut over the last step of a passed run', () => {
      expect(check({ cuts: [cut(1_400, 2_900)] })).toEqual([]);
      expect(check({ trim: { startMs: 100, endMs: 5_400 } })).toEqual([]);
    });

    it('reports cut-outside-trim for a cut past either end of the trim, or of the run', () => {
      expect(
        check({
          trim: { startMs: 500, endMs: 3_000 },
          cuts: [cut(400, 600), cut(1_000, 1_200), cut(2_900, 3_100)],
        }),
      ).toEqual([
        expect.objectContaining({ path: 'cuts[0]', code: 'cut-outside-trim' }),
        expect.objectContaining({ path: 'cuts[2]', code: 'cut-outside-trim' }),
      ]);
      expect(check({ cuts: [cut(5_000, 5_401)] })).toEqual([
        expect.objectContaining({ path: 'cuts[0]', code: 'cut-outside-trim' }),
      ]);
    });

    it('reports trim-hides-failure for a trim ending before the failed step ends', () => {
      expect(check({ trim: { endMs: 1_399 } }, undefined, 1)).toEqual([
        expect.objectContaining({
          path: 'trim.endMs',
          code: 'trim-hides-failure',
        }),
      ]);
      expect(check({ trim: { endMs: 1_400 } }, undefined, 1)).toEqual([]);
    });

    it('reports trim-hides-failure for a cut over the failed step', () => {
      expect(check({ cuts: [cut(1_300, 1_350)] }, undefined, 1)).toEqual([
        expect.objectContaining({
          path: 'cuts[0]',
          code: 'trim-hides-failure',
        }),
      ]);
      // Touching the step is not over it.
      expect(check({ cuts: [cut(100, 800)] }, undefined, 1)).toEqual([]);
    });

    it('ends the range of a failed run at the failed step', () => {
      expect(check({ cuts: [cut(1_400, 1_500)] }, undefined, 1)).toEqual([
        expect.objectContaining({ code: 'cut-outside-trim' }),
      ]);
    });

    it('reports too-short when less than 500 ms of page is left', () => {
      expect(check({ trim: { startMs: 1_000, endMs: 1_499 } })).toEqual([
        expect.objectContaining({ path: 'trim', code: 'too-short' }),
      ]);
      expect(check({ trim: { startMs: 1_000, endMs: 1_500 } })).toEqual([]);
      expect(check({ cuts: [cut(0, 4_901)] })).toEqual([
        expect.objectContaining({ path: 'cuts', code: 'too-short' }),
      ]);
      // A trim past the end of the run leaves nothing.
      expect(check({ trim: { startMs: 6_000 } })).toEqual([
        expect.objectContaining({ code: 'too-short' }),
      ]);
    });
  });
});
