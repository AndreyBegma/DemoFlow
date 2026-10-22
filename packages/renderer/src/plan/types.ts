import type {
  BackgroundConfig,
  Box,
  CardsConfig,
  FrameConfig,
  GifConfig,
  RenderFormat,
  TransitionsConfig,
  VerticalConfig,
  Viewport,
} from '@demoflow/core';

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
   * Default: measured on the timeline's sync mark, else `DEFAULT_OFFSET_MS`.
   */
  offsetMs?: number;
  idle?: {
    /** A frozen stretch at least this long is idle. Default 1 000. */
    thresholdMs?: number;
    /** An idle stretch plays in this long. Default 400. */
    compressToMs?: number;
  };
  /**
   * What a step's `zoom: true` resolves to; it does not make a step zoom
   * (ADR-0012). Default 1.35 on a 2× source, 1.25 below.
   */
  zoom?: number;
  output?: { width?: number; height?: number; fps?: number };
  /** The files to write, in order (spec 133). Default: `['mp4']`. */
  formats?: readonly RenderFormat[];
  /** The GIF's width and rate. Default: 800 px and 12 fps, at most the output's. */
  gif?: Partial<GifConfig>;
  /** The window around the page (spec 100). Default: on, as in `FrameConfigSchema`. */
  frame?: Partial<FrameConfig>;
  /** Behind the window, and behind every card. Default: the `ocean` preset. */
  background?: BackgroundConfig;
  /** Intro, scene and outro cards (spec 108). Default: none. */
  cards?: CardsConfig;
  /** Dissolves at cards and page loads (spec 114). Default: none. */
  transitions?: TransitionsConfig;
  /** The intro card's subtitle; its title is the run's scenario name. */
  scenario?: { description?: string };
  /** The 9:16 output's camera and captions (spec 176). Default: as in `VerticalConfigSchema`. */
  vertical?: Partial<VerticalConfig>;
}

/** A two-stop linear gradient; a solid colour has `from` equal to `to`. */
export interface GradientSpec {
  /** `#rrggbb` */
  from: string;
  /** `#rrggbb` */
  to: string;
  /** Degrees, as in CSS `linear-gradient`: 0 runs towards the top, clockwise. */
  angle: number;
}

/**
 * The page in a rounded window on a background (spec 100). The stage is the
 * output frame at zoom 1: the background, and the window at `RenderPlan.fit`.
 */
export interface FrameSpec {
  /** Corner radius of the window, in stage pixels. */
  radius: number;
  shadow: boolean;
  background: GradientSpec;
}

/**
 * The frames every output is encoded from; MP4 and WebM keep this size and
 * rate. The vertical MP4 is drawn at `RenderPlan.vertical`'s size instead.
 */
export interface OutputSpec {
  width: number;
  height: number;
  fps: number;
  /** One file per requested format, in `formats` order, from one FFmpeg (spec 133). */
  files: OutputFile[];
}

export type OutputFile = Mp4Spec | WebmSpec | GifSpec | Mp4VerticalSpec;

/** The 9:16 MP4 (spec 176): H.264 like `mp4`, drawn at `RenderPlan.vertical`'s size. */
export interface Mp4VerticalSpec {
  format: 'mp4-vertical';
  codec: 'h264';
  pixelFormat: 'yuv420p';
  faststart: true;
}

/** H.264, BT.709: the default output (ADR-0004). */
export interface Mp4Spec {
  format: 'mp4';
  codec: 'h264';
  pixelFormat: 'yuv420p';
  /** `-movflags +faststart`: the index goes before the media data. */
  faststart: true;
}

/** VP9 at constant quality, BT.709. */
export interface WebmSpec {
  format: 'webm';
  codec: 'vp9';
  pixelFormat: 'yuv420p';
  /** `-crf`, with `-b:v 0`: 0 (best) to 63. */
  crf: number;
  /** `-cpu-used`: higher is faster and larger. */
  cpuUsed: number;
}

/** A looping GIF with a palette per frame, scaled down and slowed. */
export interface GifSpec {
  format: 'gif';
  width: number;
  /** Follows the output's aspect ratio, rounded to an even number. */
  height: number;
  fps: number;
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
 * piece whose spans differ is an idle stretch played fast, and one with no
 * source span is a card, the page held on that frame behind it.
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

/** A key badge, e.g. `Enter`, shown just below `anchor` (viewport CSS pixels). */
export interface KeyBadge {
  startMs: number;
  endMs: number;
  text: string;
  /** Where the badge hangs from: the bottom-centre of the target, or the pointer. */
  anchor: Point;
}

/**
 * A card on the background, in time inserted between page frames (spec 108):
 * the page pauses for it and resumes on the same frame.
 */
export interface CardSpec {
  kind: 'intro' | 'scene' | 'outro';
  startMs: number;
  durationMs: number;
  title: string;
  /** The intro's description or the outro's call to action. */
  subtitle?: string;
}

/**
 * A page load (spec 114). From `startMs` the page shows the frame held at
 * `sourceMs` — on the run's first load, from about:blank, the background
 * instead — with `masks` drawn on it; at `endMs` the page is ready and the
 * held frame dissolves into it over `fadeMs` of page time, until `fadeEndMs`.
 * Cursor, rings, captions and badges keep following page time throughout.
 */
export interface NavigationHold {
  startMs: number;
  endMs: number;
  fadeEndMs: number;
  /** Page milliseconds: a card inside the dissolve does not take from it. */
  fadeMs: number;
  /** The last source frame before the navigation; absent on the first load. */
  sourceMs?: number;
  /** The masks active when the navigation started, at their boxes then (viewport CSS pixels). */
  masks: Box[];
}

export interface TransitionsSpec {
  /** Each card dissolves with the page over this long, inside its own time. */
  durationMs: number;
  /** In output order, never overlapping. */
  holds: NavigationHold[];
}

/** The crop's horizontal centre eases from each key to the next (viewport CSS pixels). */
export interface FollowKey {
  atMs: number;
  x: number;
}

/**
 * The 9:16 output (spec 176): a crop of the page, the full viewport height at
 * zoom 1, whose horizontal centre follows `follow` and which the steps' zoom
 * (`RenderPlan.camera`) narrows. It fills the frame: no window, no background.
 */
export interface VerticalSpec {
  width: number;
  height: number;
  /** Starts at the page centre; the crop is clamped to the page wherever it is. */
  follow: FollowKey[];
  /** The band at the bottom the captions sit in, output pixels. */
  caption: { top: number; height: number; fontPx: number; maxLines: number };
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
  /**
   * Where the viewport lands in the output frame at zoom 1: letterboxed and
   * centred, or — with `frame` — the window inside the margin.
   */
  fit: { x: number; y: number; scale: number };
  /** Absent when the frame is off: the page fills the output as before. */
  frame?: FrameSpec;
  offsetMs: number;
  /** Whether `offsetMs` was measured on the run's sync mark (#19). */
  offsetMeasured: boolean;
  /** Masks start this long before the field is on the page: three source frames when measured (#185), else 200. */
  maskLeadMs: number;
  /** Masks end this long after the field leaves the page: three source frames when measured (#185), else 200 (#48). */
  maskTrailMs: number;
  /** The whole video, cards and end card included. */
  durationMs: number;
  /** Contiguous from output 0 to the end of the source part and the outro; it starts after the sync mark when one was found. */
  timeMap: TimeSegment[];
  /** In output order; each one is a segment of `timeMap` with no source span. */
  cards: CardSpec[];
  /** Behind every card: the frame's background, or the configured one with the frame off. */
  cardBackground: GradientSpec;
  cursor: CursorMove[];
  clicks: ClickRing[];
  camera: CameraKeyframe[];
  masks: MaskSpan[];
  captions: Caption[];
  keys: KeyBadge[];
  /** Absent when transitions are off: the cuts are hard, as before spec 114. */
  transitions?: TransitionsSpec;
  failure?: FailureSpec;
  /** Present when `output.files` has `mp4-vertical`. */
  vertical?: VerticalSpec;
}

/** Everything a renderer draws on one output frame; geometry in output pixels. */
export interface FrameState {
  /** The source time to show; `null` on a card and on the end card. */
  sourceMs: number | null;
  /** The part of the source frame to show, in source pixels. */
  crop: Box;
  /** Where that crop is drawn in the output frame; with a frame, the window, which may run past the frame's edge. */
  content: Box;
  /** Output pixels per viewport CSS pixel on this frame, for sizing the cursor and rings. */
  scale: number;
  /** With a frame: what of the stage the camera shows, and the window's corner radius in output pixels. */
  frame?: { view: Box; radius: number };
  cursor?: Point;
  /** `progress` runs from 0 to 1 over the ring's life. */
  rings: { point: Point; progress: number }[];
  /** Clipped to `content` and to the output frame. */
  masks: Box[];
  caption?: string;
  /** The key badge to draw, hanging from `anchor` in output pixels. */
  key?: { text: string; anchor: Point };
  watermark: boolean;
  endCard?: string;
  /** An intro, scene or outro card: nothing of the page is drawn. */
  card?: { title: string; subtitle?: string; background: GradientSpec };
  /** Only the background, as behind a card: the run's first load before the page is ready (spec 114). */
  backdrop?: GradientSpec;
  /**
   * A dissolve (spec 114): `from` is drawn, then this frame over it at
   * `progress`, from 0 (only `from`) to 1 (only this frame).
   */
  fade?: { from: FrameState; progress: number };
}
