import type { Box, Viewport } from '@demoflow/core';

export interface Point {
  x: number;
  y: number;
}

/** A source or output interval, in milliseconds. */
export interface Interval {
  startMs: number;
  endMs: number;
}

/** What one FFmpeg pass learns about a video file. */
export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** e.g. `vp9`, `h264`. */
  codec: string;
  /** e.g. `yuv420p`; absent when FFmpeg does not report one. */
  pixelFormat?: string;
  /** Frozen stretches, when the probe was asked for them; otherwise empty. */
  freezes: Interval[];
}

export interface RenderPlanOptions {
  /**
   * Timeline time → source time: `sourceMs = timelineMs + offsetMs`. The
   * Playwright video leads the engine clock (#3, measured −90…−123 ms).
   */
  offsetMs?: number;
  idle?: {
    /** A frozen stretch at least this long is idle. Default 1 000. */
    thresholdMs?: number;
    /** An idle stretch plays in this long. Default 400. */
    compressToMs?: number;
  };
  /** Camera zoom on a target. Default 1.6 on a 2× source, 1.25 below. */
  zoom?: number;
  output?: { width?: number; height?: number; fps?: number };
}

export interface OutputSpec {
  width: number;
  height: number;
  fps: number;
  codec: 'h264';
  pixelFormat: 'yuv420p';
  /** `-movflags +faststart`: the index goes before the media data. */
  faststart: true;
}

export interface SourceSpec {
  /** Relative to the run directory (`timeline.json`'s `videoFile`). */
  file: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** Source pixels per viewport CSS pixel. 1 when the video is recorded at the viewport size. */
  scale: number;
}

/**
 * One piece of the time map. Output time maps linearly onto source time: a
 * piece whose spans differ is an idle stretch played fast.
 */
export interface TimeSegment {
  outputStartMs: number;
  outputEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
}

/** The drawn cursor gliding `from → to`, eased in and out. */
export interface CursorMove {
  startMs: number;
  endMs: number;
  from: Point;
  to: Point;
}

/** An expanding ring at a click point. */
export interface ClickRing {
  atMs: number;
  durationMs: number;
  point: Point;
}

/** The camera eases from each keyframe to the next. Zoom 1 shows the whole viewport. */
export interface CameraKeyframe {
  atMs: number;
  centre: Point;
  zoom: number;
}

/** A blurred rectangle; the box moves linearly between keys (a page scroll). */
export interface MaskSpan {
  startMs: number;
  endMs: number;
  keys: { atMs: number; box: Box }[];
}

export interface Caption {
  startMs: number;
  endMs: number;
  text: string;
}

export interface FailureSpec {
  stage: 'readiness' | 'execution' | 'verification' | 'recording';
  /** 1-based, as a person counts steps; absent when the failure has no step. */
  stepNumber?: number;
  message: string;
  /** A FAILED watermark on every frame, the end card included. */
  watermark: true;
  endCard: { startMs: number; durationMs: number; text: string };
}

/**
 * What a renderer draws (spec 4, Decisions). Times are output
 * milliseconds unless named `source…`; points and boxes are viewport CSS
 * pixels. Plain JSON.
 */
export interface RenderPlan {
  version: 1;
  output: OutputSpec;
  source: SourceSpec;
  viewport: Viewport;
  /** Where the viewport lands in the output frame (letterboxed, centred). */
  fit: { x: number; y: number; scale: number };
  offsetMs: number;
  /** The whole video, end card included. */
  durationMs: number;
  /** Contiguous from output 0 to the end of the source part. */
  timeMap: TimeSegment[];
  cursor: CursorMove[];
  clicks: ClickRing[];
  camera: CameraKeyframe[];
  masks: MaskSpan[];
  captions: Caption[];
  failure?: FailureSpec;
}

/** Everything a renderer draws on one output frame; geometry in output pixels. */
export interface FrameState {
  /** The source time to show; `null` on the end card. */
  sourceMs: number | null;
  /** The part of the source frame to show, in source pixels. */
  crop: Box;
  /** Where that crop is drawn in the output frame. */
  content: Box;
  /** Output pixels per viewport CSS pixel on this frame, for sizing the cursor and rings. */
  scale: number;
  cursor?: Point;
  /** `progress` runs from 0 to 1 over the ring's life. */
  rings: { point: Point; progress: number }[];
  /** Clipped to `content`. */
  masks: Box[];
  caption?: string;
  watermark: boolean;
  endCard?: string;
}
