import type { TimelineEvent } from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  captureMode,
  pageZoom,
  recordingOptions,
  toContextOptions,
} from '../../src/execute/recording.ts';
import { concatList } from '../../src/execute/screenshot-recorder.ts';
import { unzoomEvent } from '../../src/execute/zoom.ts';
import { scenario } from './scenario.ts';

/** Spike #85: the opt-in capture modes. Without the switch nothing changes. */
const viewport = { width: 1280, height: 720 };
const run = scenario([{ action: 'navigate', path: '/' }], { viewport });

describe('captureMode', () => {
  it('is video when DEMOFLOW_CAPTURE is unset or empty', () => {
    expect(captureMode(undefined)).toBe('video');
    expect(captureMode('')).toBe('video');
  });

  it('reads the two spike modes and rejects anything else', () => {
    expect(captureMode('screenshots')).toBe('screenshots');
    expect(captureMode('zoomed')).toBe('zoomed');
    expect(() => captureMode('cdp')).toThrow(/DEMOFLOW_CAPTURE/);
  });
});

describe('recording options per capture mode', () => {
  it('keeps the default recording exactly as it was', () => {
    expect(recordingOptions(run, '/runs/one', 'video')).toEqual(
      recordingOptions(run, '/runs/one'),
    );
    expect(recordingOptions(run, '/runs/one')).not.toHaveProperty('capture');
  });

  it('records a zoomed run at twice the viewport, at 1×', () => {
    const recording = recordingOptions(run, '/runs/one', 'zoomed');
    expect(recording.viewport).toEqual(viewport);
    expect(recording.deviceScaleFactor).toBe(2);
    expect(pageZoom(recording)).toBe(2);
    expect(toContextOptions(recording)).toEqual({
      viewport: { width: 2560, height: 1440 },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: '/runs/one',
        size: { width: 2560, height: 1440 },
      },
    });
  });

  it('leaves the screenshot run to its own recorder', () => {
    const recording = recordingOptions(run, '/runs/one', 'screenshots');
    expect(pageZoom(recording)).toBe(1);
    expect(toContextOptions(recording)).toEqual({
      viewport,
      deviceScaleFactor: 2,
    });
  });
});

describe('unzoomEvent', () => {
  const event: TimelineEvent = {
    stepIndex: 0,
    action: 'fill',
    startMs: 0,
    endMs: 10,
    target: { box: { x: 400, y: 300, width: 240, height: 80 } },
    pointer: { from: { x: 1280, y: 720 }, to: { x: 520, y: 340 } },
    scroll: {
      before: { x: 0, y: 0 },
      after: { x: 0, y: 600 },
      container: { x: 0, y: 0, width: 2560, height: 1440 },
    },
    maskVisibility: [
      { startMs: 0, box: { x: 400, y: 300, width: 240, height: 80 } },
    ],
  };

  it('divides every box, point and scroll offset by the zoom', () => {
    expect(unzoomEvent(event, 2)).toEqual({
      ...event,
      target: { box: { x: 200, y: 150, width: 120, height: 40 } },
      pointer: { from: { x: 640, y: 360 }, to: { x: 260, y: 170 } },
      scroll: {
        before: { x: 0, y: 0 },
        after: { x: 0, y: 300 },
        container: { x: 0, y: 0, width: 1280, height: 720 },
      },
      maskVisibility: [
        { startMs: 0, box: { x: 200, y: 150, width: 120, height: 40 } },
      ],
    });
  });

  it('returns the event itself at zoom 1', () => {
    expect(unzoomEvent(event, 1)).toBe(event);
  });
});

describe('concatList', () => {
  it('holds each frame until the next, the first from 0, the last until the end', () => {
    const list = concatList(
      [
        { atMs: 12, hash: 'a' },
        { atMs: 52, hash: 'b' },
      ],
      152,
    );
    expect(list).toBe(
      [
        'ffconcat version 1.0',
        "file 'a.jpg'",
        'duration 0.052000',
        "file 'b.jpg'",
        'duration 0.100000',
        "file 'b.jpg'",
        '',
      ].join('\n'),
    );
  });
});
