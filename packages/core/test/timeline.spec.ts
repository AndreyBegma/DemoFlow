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

  it('rejects an unknown field', () => {
    expect(TimelineSchema.safeParse({ ...timeline, fps: 30 }).success).toBe(
      false,
    );
  });
});
