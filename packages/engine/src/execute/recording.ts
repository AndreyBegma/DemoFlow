import type { Scenario, Viewport } from '@demoflow/core';
import type { BrowserContext, BrowserContextOptions } from 'playwright';

/** ADR-0004 §1: twice the CSS pixels, so the renderer has pixels to zoom into. */
export const DEVICE_SCALE_FACTOR = 2;

/**
 * Spike #85, opt-in through `DEMOFLOW_CAPTURE`: how the source is captured.
 * `video` is Playwright's `recordVideo` at the viewport size, the default.
 * `screenshots` pulls device-pixel screenshots over CDP and encodes them;
 * `zoomed` records a viewport twice the size with the page zoomed 200%.
 */
export type CaptureMode = 'video' | 'screenshots' | 'zoomed';

export const CAPTURE_MODES: readonly CaptureMode[] = [
  'video',
  'screenshots',
  'zoomed',
];

/** Reads `DEMOFLOW_CAPTURE`; unset or empty is `video`, anything unknown throws. */
export function captureMode(value: string | undefined): CaptureMode {
  if (value === undefined || value === '') return 'video';
  const mode = CAPTURE_MODES.find((known) => known === value);
  if (mode === undefined) {
    throw new Error(
      `DEMOFLOW_CAPTURE must be one of ${CAPTURE_MODES.join(', ')}; got "${value}"`,
    );
  }
  return mode;
}

/** How the browser context records the run. */
export interface RecordingOptions {
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
  /** Spike #85: absent for the default `video` capture. */
  capture?: Exclude<CaptureMode, 'video'>;
}

export function recordingOptions(
  scenario: Scenario,
  runDir: string,
  capture: CaptureMode = 'video',
): RecordingOptions {
  const recording: RecordingOptions = {
    viewport: scenario.viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    videoDir: runDir,
    videoSize: { ...scenario.viewport },
  };
  if (capture === 'video') return recording;
  return {
    ...recording,
    videoSize: scale(scenario.viewport, DEVICE_SCALE_FACTOR),
    capture,
  };
}

/**
 * The page zoom of a `zoomed` capture, 1 otherwise. Boxes and points the
 * engine measures are in the zoomed viewport and are divided by it.
 */
export function pageZoom(recording: RecordingOptions): number {
  return recording.capture === 'zoomed' ? recording.deviceScaleFactor : 1;
}

export function toContextOptions(
  recording: RecordingOptions,
): BrowserContextOptions {
  switch (recording.capture) {
    case undefined:
      return {
        viewport: recording.viewport,
        deviceScaleFactor: recording.deviceScaleFactor,
        recordVideo: { dir: recording.videoDir, size: recording.videoSize },
      };
    case 'screenshots':
      // The screenshot recorder writes the video.
      return {
        viewport: recording.viewport,
        deviceScaleFactor: recording.deviceScaleFactor,
      };
    case 'zoomed':
      // Twice the viewport at 1×; the page is zoomed back to the scenario's layout width.
      return {
        viewport: recording.videoSize,
        deviceScaleFactor: 1,
        recordVideo: { dir: recording.videoDir, size: recording.videoSize },
      };
  }
}

/**
 * Zooms every document of a `zoomed` context before any of its scripts runs.
 * An adopted stylesheet exists before `<html>` is parsed and is set again on
 * every navigation, as init scripts are.
 */
export async function zoomPages(
  context: BrowserContext,
  zoom: number,
): Promise<void> {
  await context.addInitScript((value: number) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`html { zoom: ${value} !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, zoom);
}

function scale(viewport: Viewport, factor: number): Viewport {
  return { width: viewport.width * factor, height: viewport.height * factor };
}
