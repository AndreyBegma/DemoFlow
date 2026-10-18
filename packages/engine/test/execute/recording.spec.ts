import { describe, expect, it } from 'vitest';
import {
  DEVICE_SCALE_FACTOR,
  recordingOptions,
  toContextOptions,
} from '../../src/execute/recording.ts';
import { scenario } from './scenario.ts';

describe('recording options', () => {
  it.each([
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 800, height: 600 },
  ])('records %o at the viewport size', (viewport) => {
    const context = toContextOptions(
      recordingOptions(
        scenario([{ action: 'navigate', path: '/' }], { viewport }),
        '/runs/one',
      ),
    );
    expect(context.viewport).toEqual(viewport);
    expect(context.deviceScaleFactor).toBe(DEVICE_SCALE_FACTOR);
    expect(context.deviceScaleFactor).toBe(2);
    expect(context.recordVideo?.size).toEqual(viewport);
  });
});
