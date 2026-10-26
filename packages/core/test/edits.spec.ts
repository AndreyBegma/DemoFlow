import { describe, expect, it } from 'vitest';
import {
  checkRunEdits,
  type RunEdits,
  RunEditsSchema,
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

const caption = (startMs: number, endMs: number, text = 'Hello') => ({
  startMs,
  endMs,
  text,
});

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
    ['an unknown key', { schemaVersion: 1, trim: { startMs: 0 } }],
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
  ])('rejects %s', (_, edits) => {
    expect(
      RunEditsSchema.safeParse({ schemaVersion: 1, ...edits }).success,
    ).toBe(false);
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
  const check = (edits: Omit<RunEdits, 'schemaVersion'>, tailMs?: number) =>
    checkRunEdits(
      RunEditsSchema.parse({ schemaVersion: 1, ...edits }),
      timeline,
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
});
