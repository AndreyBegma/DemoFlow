import type { Device, Scenario, Viewport } from '@demoflow/core';
import type { BrowserContextOptions } from 'playwright';

/** ADR-0004 §1: twice the CSS pixels, so the renderer has pixels to zoom into. */
export const DEVICE_SCALE_FACTOR = 2;

/** How the browser context records the run. */
export interface RecordingOptions {
  device: Device;
  viewport: Viewport;
  deviceScaleFactor: number;
  /** Playwright writes `<guid>.webm` here; capture names the file. */
  videoDir: string;
  /**
   * The video frame size: the viewport, in CSS pixels. Set explicitly because
   * Playwright's default scales the recording down to fit 800×800. It must not
   * be larger than the viewport: Playwright does not upscale, it pads the
   * viewport-sized frame into the top-left corner of the bigger canvas and
   * fills the rest with grey (#47).
   */
  videoSize: Viewport;
}

export function recordingOptions(
  scenario: Scenario,
  runDir: string,
): RecordingOptions {
  return {
    device: scenario.device,
    viewport: scenario.viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    videoDir: runDir,
    videoSize: { ...scenario.viewport },
  };
}

/** Chrome for Android, with the launched browser's own version (spec 305 Decision 3). */
function phoneUserAgent(browserVersion: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Mobile Safari/537.36`;
}

/**
 * The context options of the run. `video: false` for the off-camera context
 * (spec 171): the same browser, viewport and device, with nothing recorded.
 */
export function toContextOptions(
  recording: RecordingOptions,
  browserVersion: string,
  { video = true }: { video?: boolean } = {},
): BrowserContextOptions {
  return {
    viewport: recording.viewport,
    deviceScaleFactor: recording.deviceScaleFactor,
    ...(video
      ? { recordVideo: { dir: recording.videoDir, size: recording.videoSize } }
      : {}),
    ...(recording.device === 'phone'
      ? {
          isMobile: true,
          hasTouch: true,
          userAgent: phoneUserAgent(browserVersion),
        }
      : {}),
  };
}
