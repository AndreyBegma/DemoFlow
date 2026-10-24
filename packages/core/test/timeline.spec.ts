import { describe, expect, it } from 'vitest';
import { TimelineSchema } from '../src/index.ts';

const timeline = {
  schemaVersion: 1,
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  videoFile: 'source.webm',
  events: [
    { stepIndex: 0, action: 'navigate', startMs: 0, endMs: 820 },
    {
      stepIndex: 1,
      action: 'click',
      startMs: 820,
      endMs: 1400,
      target: { box: { x: 100, y: 200, width: 80, height: 32 } },
      pointer: { from: { x: 960, y: 540 }, to: { x: 140, y: 216 } },
      caption: 'Open the form',
    },
    {
      stepIndex: 2,
      action: 'fill',
      startMs: 1400,
      endMs: 2100,
      target: { box: { x: 100, y: 260, width: 300, height: 32 } },
      masked: true,
      value: '***',
    },
    {
      stepIndex: 3,
      action: 'scroll',
      startMs: 2100,
      endMs: 2600,
      scroll: {
        before: { x: 0, y: 0 },
        after: { x: 0, y: 900 },
        container: { x: 0, y: 80, width: 400, height: 900 },
      },
    },
    {
      stepIndex: 4,
      action: 'assertText',
      startMs: 2600,
      endMs: 2700,
      assertion: { passed: false, message: 'expected "Saved"' },
      error: { message: 'expected "Saved"' },
    },
    {
      stepIndex: 5,
      action: 'marker',
      startMs: 2700,
      endMs: 2700,
      marker: { title: 'Done', kind: 'scene' },
    },
    {
      stepIndex: 6,
      action: 'screenshot',
      startMs: 2700,
      endMs: 2750,
      screenshot: 'screenshots/done.png',
    },
  ],
};

describe('TimelineSchema', () => {
  it('parses a timeline', () => {
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
  });

  it('rejects a masked fill that carries the real value', () => {
    const events = [{ ...timeline.events[2], masked: true, value: 'hunter2' }];
    const parsed = TimelineSchema.safeParse({ ...timeline, events });
    expect(parsed.error?.issues[0]?.path).toEqual(['events', 0, 'value']);
  });

  it('rejects an event that ends before it starts', () => {
    const events = [{ stepIndex: 0, action: 'wait', startMs: 10, endMs: 5 }];
    const parsed = TimelineSchema.safeParse({ ...timeline, events });
    expect(parsed.error?.issues[0]?.path).toEqual(['events', 0, 'endMs']);
  });

  it('rejects an action that is not a step action', () => {
    const events = [{ stepIndex: 0, action: 'type', startMs: 0, endMs: 1 }];
    expect(TimelineSchema.safeParse({ ...timeline, events }).success).toBe(
      false,
    );
  });

  describe('syncMark', () => {
    const mark = { colour: '#ff00ff', onMs: 40, offMs: 200 };
    const withMark = (syncMark: unknown, events = timeline.events) => ({
      ...timeline,
      events,
      syncMark,
    });

    it('accepts a timeline without one', () => {
      expect(TimelineSchema.safeParse(timeline).success).toBe(true);
    });

    it('accepts a mark cleared at or before the first event', () => {
      for (const startMs of [200, 300]) {
        const events = [{ ...timeline.events[0], startMs, endMs: 400 }];
        expect(
          TimelineSchema.safeParse(withMark(mark, events as never)).success,
        ).toBe(true);
      }
    });

    it('rejects offMs at or before onMs', () => {
      for (const offMs of [40, 10]) {
        const parsed = TimelineSchema.safeParse(withMark({ ...mark, offMs }));
        expect(parsed.error?.issues[0]?.path).toEqual(['syncMark', 'offMs']);
      }
    });

    it('rejects a malformed colour', () => {
      for (const colour of ['ff00ff', '#FF00FF', '#f0f', 'magenta']) {
        const parsed = TimelineSchema.safeParse(withMark({ ...mark, colour }));
        expect(parsed.error?.issues[0]?.path).toEqual(['syncMark', 'colour']);
      }
    });

    it('rejects offMs after the first event starts', () => {
      const late = TimelineSchema.safeParse(
        withMark({ ...mark, offMs: 500 }, [
          { ...timeline.events[0], startMs: 100, endMs: 200 },
        ] as never),
      );
      expect(late.error?.issues[0]?.path).toEqual(['syncMark', 'offMs']);
    });
  });

  it('rejects an unknown field', () => {
    expect(TimelineSchema.safeParse({ ...timeline, fps: 30 }).success).toBe(
      false,
    );
  });
});

describe('key', () => {
  const press = {
    stepIndex: 0,
    action: 'press',
    startMs: 0,
    endMs: 300,
    key: 'Enter',
  };
  const parse = (event: Record<string, unknown>) =>
    TimelineSchema.safeParse({ ...timeline, events: [event] });

  it('accepts a key on a press event', () => {
    expect(parse(press).success).toBe(true);
  });

  it('rejects a key on any other event, at the key', () => {
    const parsed = parse({ ...press, action: 'click' });
    expect(parsed.error?.issues[0]?.path).toEqual(['events', 0, 'key']);
  });

  it('rejects an empty key', () => {
    expect(parse({ ...press, key: '' }).success).toBe(false);
  });
});

describe('zoom', () => {
  const click = {
    stepIndex: 0,
    action: 'click',
    startMs: 0,
    endMs: 300,
    target: { box: { x: 0, y: 0, width: 80, height: 32 } },
  };
  const parse = (event: Record<string, unknown>) =>
    TimelineSchema.safeParse({ ...timeline, events: [event] });

  it.each([true, false, 1, 1.35, 3])('carries the step value %j', (zoom) => {
    expect(parse({ ...click, zoom }).data?.events[0]?.zoom).toBe(zoom);
  });

  it.each([0.5, 3.5, 'yes'])('rejects %j at the zoom', (zoom) => {
    const parsed = parse({ ...click, zoom });
    expect(parsed.error?.issues[0]?.path).toEqual(['events', 0, 'zoom']);
  });
});

describe('maskVisibility', () => {
  const box = { x: 100, y: 260, width: 300, height: 32 };
  const moved = { x: 100, y: 420, width: 300, height: 32 };

  function parse(
    maskVisibility: unknown,
    fill: Record<string, unknown> = timeline.events[2],
  ) {
    const event = { ...fill, maskVisibility };
    return TimelineSchema.safeParse({ ...timeline, events: [event] });
  }

  it('accepts one closed interval', () => {
    expect(parse([{ startMs: 1400, endMs: 3000, box }]).success).toBe(true);
  });

  it('accepts one open interval', () => {
    expect(parse([{ startMs: 1400, box }]).success).toBe(true);
  });

  it('accepts a field that leaves and comes back elsewhere', () => {
    const intervals = [
      { startMs: 1400, endMs: 3000, box },
      { startMs: 4000, box: moved },
    ];
    expect(parse(intervals).success).toBe(true);
  });

  it('accepts a new interval that starts before a closed one ends', () => {
    // A step that navigates to a page showing the same field: the old box
    // ends at the step's endMs, the new one starts at its startMs.
    const intervals = [
      { startMs: 1400, endMs: 3000, box },
      { startMs: 2600, endMs: 5000, box: moved },
    ];
    expect(parse(intervals).success).toBe(true);
  });

  it('rejects maskVisibility on an event that is not masked', () => {
    const { masked: _, value: __, ...plain } = timeline.events[2];
    for (const fill of [plain, { ...plain, masked: false }]) {
      const parsed = parse([{ startMs: 1400, box }], fill);
      expect(parsed.error?.issues[0]?.path).toEqual([
        'events',
        0,
        'maskVisibility',
      ]);
    }
  });

  it('rejects an interval that ends before it starts', () => {
    const parsed = parse([{ startMs: 1400, endMs: 1000, box }]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'events',
      0,
      'maskVisibility',
      0,
      'endMs',
    ]);
  });

  it('rejects unordered intervals', () => {
    const parsed = parse([
      { startMs: 4000, endMs: 5000, box },
      { startMs: 1400, endMs: 3000, box: moved },
    ]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'events',
      0,
      'maskVisibility',
      1,
      'startMs',
    ]);
  });

  it('rejects an interval that overlaps an open one', () => {
    const parsed = parse([
      { startMs: 1400, box },
      { startMs: 2000, endMs: 3000, box: moved },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('rejects an open interval that is not the last', () => {
    const parsed = parse([
      { startMs: 1400, box },
      { startMs: 4000, box: moved },
    ]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'events',
      0,
      'maskVisibility',
      0,
      'endMs',
    ]);
  });

  it('rejects an interval without a box', () => {
    expect(parse([{ startMs: 1400 }]).success).toBe(false);
  });
});

describe('navigations', () => {
  const parse = (navigations: unknown) =>
    TimelineSchema.safeParse({ ...timeline, navigations });

  it('is optional: a timeline from before #114 still parses', () => {
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
  });

  it('accepts closed navigations in order and an open last one', () => {
    const parsed = parse([
      { startMs: 0, endMs: 820 },
      { startMs: 1300, endMs: 1900 },
      { startMs: 2600 },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('accepts a navigation that starts as the previous one ends', () => {
    expect(
      parse([
        { startMs: 0, endMs: 820 },
        { startMs: 820, endMs: 900 },
      ]).success,
    ).toBe(true);
  });

  it('rejects a navigation that ends before or as it starts', () => {
    for (const endMs of [800, 820]) {
      const parsed = parse([{ startMs: 820, endMs }]);
      expect(parsed.error?.issues[0]?.path).toEqual([
        'navigations',
        0,
        'endMs',
      ]);
    }
  });

  it('rejects overlapping or unordered navigations', () => {
    for (const second of [
      { startMs: 500, endMs: 1000 },
      { startMs: 100, endMs: 200 },
    ]) {
      const parsed = parse([{ startMs: 0, endMs: 820 }, second]);
      expect(parsed.error?.issues[0]?.path).toEqual([
        'navigations',
        1,
        'startMs',
      ]);
    }
  });

  it('rejects an open navigation that is not the last', () => {
    const parsed = parse([{ startMs: 0 }, { startMs: 1300, endMs: 1900 }]);
    expect(parsed.error?.issues[0]?.path).toEqual(['navigations', 0, 'endMs']);
  });

  it('rejects an unknown field on a navigation', () => {
    expect(parse([{ startMs: 0, endMs: 820, url: '/x' }]).success).toBe(false);
  });
});

describe('maskedElements', () => {
  const box = { x: 40, y: 40, width: 200, height: 24 };
  const parse = (maskedElements: unknown) =>
    TimelineSchema.safeParse({ ...timeline, maskedElements });

  it('is optional: a timeline from before #197 still parses', () => {
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
  });

  it('accepts elements with closed, open and one-frame-overlapping intervals', () => {
    const parsed = parse([
      {
        intervals: [
          { startMs: 0, endMs: 500, box },
          // A move: the new box starts one frame before the old one ends.
          { startMs: 484, endMs: 900, box: { ...box, y: 60 } },
          { startMs: 1200, box },
        ],
      },
      { intervals: [{ startMs: 300, endMs: 400, box }] },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty list of elements', () => {
    expect(parse([]).success).toBe(true);
  });

  it('rejects an element without intervals', () => {
    const parsed = parse([{ intervals: [] }]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'maskedElements',
      0,
      'intervals',
    ]);
  });

  it('rejects unordered intervals', () => {
    const parsed = parse([
      {
        intervals: [
          { startMs: 500, endMs: 600, box },
          { startMs: 100, endMs: 200, box },
        ],
      },
    ]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'maskedElements',
      0,
      'intervals',
      1,
      'startMs',
    ]);
  });

  it('rejects an open interval that is not the last', () => {
    const parsed = parse([
      {
        intervals: [
          { startMs: 0, box },
          { startMs: 100, endMs: 200, box },
        ],
      },
    ]);
    expect(parsed.error?.issues[0]?.path).toEqual([
      'maskedElements',
      0,
      'intervals',
      0,
      'endMs',
    ]);
  });

  it('rejects an unknown field on an element', () => {
    expect(
      parse([{ intervals: [{ startMs: 0, box }], selector: '#key' }]).success,
    ).toBe(false);
  });
});

describe('annotations', () => {
  const parse = (annotations: unknown) =>
    TimelineSchema.safeParse({ ...timeline, annotations });

  it('accepts scenes and captions in time order, equal times included', () => {
    expect(
      parse([
        { atMs: 0, kind: 'scene', title: 'Checkout' },
        { atMs: 500, kind: 'caption', title: 'Paying with a card' },
        { atMs: 500, kind: 'scene', title: 'Done' },
      ]).success,
    ).toBe(true);
  });

  it('accepts an empty list and a timeline without the field', () => {
    expect(parse([]).success).toBe(true);
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
  });

  it('accepts a 120-character title', () => {
    expect(
      parse([{ atMs: 0, kind: 'caption', title: 'a'.repeat(120) }]).success,
    ).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(
      parse([{ atMs: 0, kind: 'scene', title: '' }]).error?.issues[0]?.path,
    ).toEqual(['annotations', 0, 'title']);
  });

  it('rejects a 121-character title', () => {
    expect(
      parse([{ atMs: 0, kind: 'scene', title: 'a'.repeat(121) }]).error
        ?.issues[0]?.path,
    ).toEqual(['annotations', 0, 'title']);
  });

  it('rejects an unknown kind', () => {
    expect(
      parse([{ atMs: 0, kind: 'note', title: 'x' }]).error?.issues[0]?.path,
    ).toEqual(['annotations', 0, 'kind']);
  });

  it('rejects entries out of atMs order', () => {
    expect(
      parse([
        { atMs: 500, kind: 'scene', title: 'a' },
        { atMs: 100, kind: 'caption', title: 'b' },
      ]).error?.issues[0]?.path,
    ).toEqual(['annotations', 1, 'atMs']);
  });
});

describe('TimelineSchema — device', () => {
  it('parses a timeline without a device', () => {
    expect(TimelineSchema.parse(timeline).device).toBeUndefined();
  });

  it.each(['desktop', 'phone'])('parses device %s', (device) => {
    expect(TimelineSchema.parse({ ...timeline, device }).device).toBe(device);
  });

  it('rejects an unknown device', () => {
    expect(
      TimelineSchema.safeParse({ ...timeline, device: 'tablet' }).success,
    ).toBe(false);
  });
});
