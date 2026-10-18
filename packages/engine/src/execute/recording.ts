import type { Scenario, Viewport } from '@demoflow/core';
import type { BrowserContextOptions } from 'playwright';

/** ADR-0004 §1: twice the CSS pixels, so the renderer has pixels to zoom into. */
export const DEVICE_SCALE_FACTOR = 2;

/** How the browser context records the run. */
export interface RecordingOptions {
  viewport: Viewport;
  deviceScaleFactor: number;
  /** Playwright writes `<guid>.webm` here; capture names the file. */
  videoDir: string;
  /**
   * The video frame size, in device pixels (`viewport × deviceScaleFactor`).
   * Set explicitly: Playwright's default scales the recording down to fit
   * 800×800, and a CSS-sized frame would leave the renderer's camera zoom
   * with no source pixels behind it (ADR-0004 §1).
   */
  videoSize: Viewport;
}

export function recordingOptions(
  scenario: Scenario,
  runDir: string,
): RecordingOptions {
  return {
    viewport: scenario.viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    videoDir: runDir,
    videoSize: {
      width: scenario.viewport.width * DEVICE_SCALE_FACTOR,
      height: scenario.viewport.height * DEVICE_SCALE_FACTOR,
    },
  };
}

export function toContextOptions(
  recording: RecordingOptions,
): BrowserContextOptions {
  return {
    viewport: recording.viewport,
    deviceScaleFactor: recording.deviceScaleFactor,
    recordVideo: { dir: recording.videoDir, size: recording.videoSize },
  };
}
