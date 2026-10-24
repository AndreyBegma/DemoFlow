import { parseScenario } from '@demoflow/core';
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
      '131.0.6778.33',
    );
    expect(context.viewport).toEqual(viewport);
    expect(context.deviceScaleFactor).toBe(DEVICE_SCALE_FACTOR);
    expect(context.deviceScaleFactor).toBe(2);
    expect(context.recordVideo?.size).toEqual(viewport);
  });

  const options = (device: 'desktop' | 'phone') => {
    const parsed = parseScenario({
      schemaVersion: 1,
      name: 'inline',
      device,
      steps: [{ action: 'navigate', path: '/' }],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return toContextOptions(
      recordingOptions(parsed.value, '/runs/one'),
      '131.0.6778.33',
    );
  };

  it('makes a phone a touch device with a mobile user agent', () => {
    const context = options('phone');
    expect(context.isMobile).toBe(true);
    expect(context.hasTouch).toBe(true);
    expect(context.userAgent).toContain('Android');
    expect(context.userAgent).toContain('Mobile');
    expect(context.userAgent).toContain('Chrome/131.0.6778.33');
    expect(context.viewport).toEqual({ width: 412, height: 915 });
    expect(context.recordVideo?.size).toEqual({ width: 412, height: 915 });
    expect(context.deviceScaleFactor).toBe(DEVICE_SCALE_FACTOR);
  });

  it('leaves a desktop without touch or a user agent', () => {
    const context = options('desktop');
    expect(context).not.toHaveProperty('isMobile');
    expect(context).not.toHaveProperty('hasTouch');
    expect(context).not.toHaveProperty('userAgent');
    expect(context.viewport).toEqual({ width: 1920, height: 1080 });
  });
});
