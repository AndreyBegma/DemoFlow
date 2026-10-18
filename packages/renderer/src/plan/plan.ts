import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Box,
  type RunResult,
  RunResultSchema,
  type StepAction,
  type Timeline,
  type TimelineEvent,
  TimelineSchema,
} from '@demoflow/core';
import { probeVideo } from './ffmpeg.ts';
import { findSyncClear, syncOffset } from './sync-mark.ts';
import { buildTimeMap, idleStretches, toOutputMs } from './time-map.ts';
import type {
  CameraKeyframe,
  Caption,
  ClickRing,
  CursorMove,
  FailureSpec,
  Interval,
  MaskSpan,
  Point,
  RenderPlan,
  RenderPlanOptions,
  VideoProbe,
} from './types.ts';

/** The run files the plan reads (spec 3, Decisions). */
export const PLAN_INPUTS = {
  timeline: 'timeline.json',
  result: 'result.json',
} as const;

/** The Playwright video leads the engine clock by ~100 ms (#3, measured −90…−123 ms). */
export const DEFAULT_OFFSET_MS = -100;

export const DEFAULTS = {
  idleThresholdMs: 1_000,
  idleCompressToMs: 400,
  output: { width: 1920, height: 1080, fps: 30 },
  /** Zoom on a source with at least two pixels per CSS pixel (ADR-0004 §1). */
  zoom: 1.6,
  /** Zoom on a 1× source: past the source pixels already, so kept gentle (spec 4, Risks). */
  zoomOnLowResSource: 1.25,
} as const;

/** Spec 4, Decisions. */
const TIMING = {
  clickRingMs: 300,
  zoomInMs: 500,
  zoomOutMs: 400,
  captionTailMs: 800,
  endCardMs: 3_000,
  /** A target whose centre is closer than this to the previous one keeps the zoom and pans. */
  keepZoomWithinPx: 400,
  /** A pan never whips across in less than this. */
  minPanMs: 400,
  /** The engine waits up to this long for a navigation after the press. */
  pressToEndMs: 100,
  /** Masks start this early, to absorb the residual clock offset; one source frame when it is measured. */
  maskLeadMs: 200,
  /** Masks overhang the field's box by this much on every side. */
  maskMarginPx: 4,
  /** A successful run keeps this much video after its last event. */
  tailMs: 1_000,
  /** A target box fills at most this share of the zoomed view. */
  targetFill: 0.9,
} as const;

/** Events that move the page or the pointer. A frozen frame during any other step is idle. */
const ACTIVE: ReadonlySet<StepAction> = new Set([
  'navigate',
  'click',
  'hover',
  'fill',
  'select',
  'scroll',
]);
const CAMERA: ReadonlySet<StepAction> = new Set(['click', 'fill', 'select']);

export interface PlanInput {
  timeline: Timeline;
  result: RunResult;
  /** The source video, probed for frozen stretches at the idle threshold. */
  source: VideoProbe;
  /** The source time of the first frame after `timeline.syncMark`, when it was found. */
  syncClearMs?: number;
}

/**
 * Reads a run directory and plans its video: `timeline.json`, `result.json`,
 * one FFmpeg pass over the source (size, frame rate, frozen stretches) and,
 * when the timeline has a sync mark, one over its start to find the mark.
 */
export async function buildRenderPlan(
  runDir: string,
  options: RenderPlanOptions = {},
): Promise<RenderPlan> {
  const timeline = TimelineSchema.parse(
    await readJson(path.join(runDir, PLAN_INPUTS.timeline)),
  );
  const result = RunResultSchema.parse(
    await readJson(path.join(runDir, PLAN_INPUTS.result)),
  );
  const videoFile = path.join(runDir, timeline.videoFile);
  const source = await probeVideo(videoFile, {
    freezes: {
      minMs: options.idle?.thresholdMs ?? DEFAULTS.idleThresholdMs,
    },
  });
  const syncClearMs =
    timeline.syncMark === undefined
      ? undefined
      : await findSyncClear(videoFile, source.fps, timeline.syncMark);
  return planRender(
    {
      timeline,
      result,
      source,
      ...(syncClearMs === undefined ? {} : { syncClearMs }),
    },
    options,
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The render plan of a run, without touching the disk (spec 4, Decisions). */
export function planRender(
  input: PlanInput,
  options: RenderPlanOptions = {},
): RenderPlan {
  const { timeline, result, source } = input;
  // Measured on the sync mark when it was found (#19); otherwise the defaults.
  const measuredMs =
    timeline.syncMark === undefined
      ? undefined
      : syncOffset(timeline.syncMark, input.syncClearMs);
  const offsetMs = options.offsetMs ?? measuredMs ?? DEFAULT_OFFSET_MS;
  const offsetMeasured =
    options.offsetMs === undefined && measuredMs !== undefined;
  const maskLeadMs = offsetMeasured ? 1000 / source.fps : TIMING.maskLeadMs;
  // The output starts on the first frame after the mark, so none shows it (Decision 6).
  const startMs =
    measuredMs === undefined
      ? 0
      : clamp(input.syncClearMs ?? 0, 0, source.durationMs);
  const thresholdMs = options.idle?.thresholdMs ?? DEFAULTS.idleThresholdMs;
  const compressToMs = options.idle?.compressToMs ?? DEFAULTS.idleCompressToMs;
  const output = {
    width: options.output?.width ?? DEFAULTS.output.width,
    height: options.output?.height ?? DEFAULTS.output.height,
    fps: options.output?.fps ?? DEFAULTS.output.fps,
  };
  const viewport = timeline.viewport;
  const sourceScale = source.width / viewport.width;
  const maxZoom =
    options.zoom ??
    (sourceScale >= 2 ? DEFAULTS.zoom : DEFAULTS.zoomOnLowResSource);

  const events = timeline.events;
  const failure = failedStage(result);
  const toSource = (timelineMs: number): number =>
    clamp(timelineMs + offsetMs, 0, source.durationMs);

  // The video ends at the failure, or a little after the last event.
  const failedEvent =
    failure?.stepIndex === undefined
      ? undefined
      : events.find((event) => event.stepIndex === failure.stepIndex);
  const lastEvent = events.at(-1);
  const sourceEndMs =
    failure !== undefined
      ? toSource(failedEvent?.endMs ?? lastEvent?.endMs ?? source.durationMs)
      : lastEvent === undefined
        ? source.durationMs
        : toSource(lastEvent.endMs + TIMING.tailMs);

  const active: Interval[] = events
    .filter((event) => ACTIVE.has(event.action))
    .map((event) => ({
      startMs: toSource(event.startMs),
      endMs: toSource(event.endMs),
    }));
  const idle = idleStretches(source.freezes, active, thresholdMs, sourceEndMs);
  const timeMap = buildTimeMap(idle, sourceEndMs, compressToMs, startMs);
  const out = (timelineMs: number): number =>
    toOutputMs(timeMap, toSource(timelineMs));
  const videoEndMs = timeMap.at(-1)?.outputEndMs ?? 0;

  const failureSpec =
    failure === undefined
      ? undefined
      : failureCard(failure, videoEndMs, TIMING.endCardMs);

  return {
    version: 1,
    output: {
      ...output,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      faststart: true,
    },
    source: {
      file: timeline.videoFile,
      width: source.width,
      height: source.height,
      fps: source.fps,
      durationMs: source.durationMs,
      scale: sourceScale,
    },
    viewport,
    fit: fitInto(viewport, output),
    offsetMs,
    offsetMeasured,
    maskLeadMs,
    durationMs: videoEndMs + (failureSpec?.endCard.durationMs ?? 0),
    timeMap,
    cursor: cursorMoves(events, out),
    clicks: clickRings(events, out),
    camera: cameraKeyframes(events, out, viewport, maxZoom),
    masks: maskSpans(events, out, viewport, videoEndMs, maskLeadMs),
    captions: captions(events, out, videoEndMs),
    ...(failureSpec === undefined ? {} : { failure: failureSpec }),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Failure {
  stage: FailureSpec['stage'];
  message: string;
  stepIndex?: number;
}

/**
 * The capture stages decide whether the run failed. `rendering` and
 * `storage` do not: a failed earlier render must not watermark the next one.
 */
function failedStage(result: RunResult): Failure | undefined {
  for (const stage of [
    'readiness',
    'execution',
    'verification',
    'recording',
  ] as const) {
    const state = result.stages[stage];
    if (state.status === 'failed') {
      return {
        stage,
        message: state.error?.message ?? 'no message',
        ...(state.error?.stepIndex === undefined
          ? {}
          : { stepIndex: state.error.stepIndex }),
      };
    }
  }
  return undefined;
}

function failureCard(
  failure: Failure,
  startMs: number,
  durationMs: number,
): FailureSpec {
  const stage = failure.stage[0].toUpperCase() + failure.stage.slice(1);
  const stepNumber =
    failure.stepIndex === undefined ? undefined : failure.stepIndex + 1;
  const where = stepNumber === undefined ? '' : ` at step ${stepNumber}`;
  return {
    stage: failure.stage,
    ...(stepNumber === undefined ? {} : { stepNumber }),
    message: failure.message,
    watermark: true,
    endCard: {
      startMs,
      durationMs,
      text: `${stage} failed${where}: ${failure.message}`,
    },
  };
}

function fitInto(
  viewport: { width: number; height: number },
  output: { width: number; height: number },
): RenderPlan['fit'] {
  const scale = Math.min(
    output.width / viewport.width,
    output.height / viewport.height,
  );
  return {
    x: (output.width - viewport.width * scale) / 2,
    y: (output.height - viewport.height * scale) / 2,
    scale,
  };
}

/** The instant the button went down: the engine waits up to 100 ms for a navigation after it. */
function pressMs(event: TimelineEvent): number {
  return event.action === 'click'
    ? Math.max(event.startMs, event.endMs - TIMING.pressToEndMs)
    : event.endMs;
}

function cursorMoves(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
): CursorMove[] {
  return events.flatMap((event) =>
    event.pointer === undefined
      ? []
      : [
          {
            startMs: out(event.startMs),
            endMs: out(pressMs(event)),
            from: event.pointer.from,
            to: event.pointer.to,
          },
        ],
  );
}

function clickRings(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
): ClickRing[] {
  return events.flatMap((event) =>
    event.action !== 'click' || event.pointer === undefined
      ? []
      : [
          {
            atMs: out(pressMs(event)),
            durationMs: TIMING.clickRingMs,
            point: event.pointer.to,
          },
        ],
  );
}

interface Shot {
  /** The action itself: the press of a click, the whole of a fill or select. */
  startMs: number;
  endMs: number;
  centre: Point;
  zoom: number;
}

/**
 * Zoom on the target of every `click`, `fill` and `select`: in over 500 ms
 * before the action, out over 400 ms after. A target near the previous one,
 * or one whose zoom-in would start before the previous zoom-out ends, keeps
 * the zoom and pans instead.
 */
function cameraKeyframes(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  maxZoom: number,
): CameraKeyframe[] {
  const shots: Shot[] = events.flatMap((event) => {
    if (!CAMERA.has(event.action) || event.target === undefined) return [];
    const { box } = event.target;
    const zoom = Math.max(
      1,
      Math.min(
        maxZoom,
        (TIMING.targetFill * viewport.width) / Math.max(box.width, 1),
        (TIMING.targetFill * viewport.height) / Math.max(box.height, 1),
      ),
    );
    const action =
      event.action === 'click'
        ? { startMs: out(pressMs(event)), endMs: out(pressMs(event)) }
        : { startMs: out(event.startMs), endMs: out(event.endMs) };
    return [{ ...action, centre: centreOf(box), zoom }];
  });

  const keys: CameraKeyframe[] = [];
  const push = (atMs: number, centre: Point, zoom: number): void => {
    const last = keys.at(-1);
    keys.push({ atMs: Math.max(atMs, last?.atMs ?? 0, 0), centre, zoom });
  };
  const zoomOut = (shot: Shot): void => {
    push(shot.endMs, shot.centre, shot.zoom);
    push(shot.endMs + TIMING.zoomOutMs, shot.centre, 1);
  };
  let previous: Shot | undefined;
  for (const shot of shots) {
    // The camera arrives as the action starts, or later when it has no room to
    // ease: a shot in the first 500 ms, a pan right after the previous action.
    let arriveMs = shot.startMs;
    if (previous === undefined) {
      const fromMs = Math.max(0, shot.startMs - TIMING.zoomInMs);
      push(fromMs, shot.centre, 1);
      arriveMs = Math.max(arriveMs, fromMs + TIMING.zoomInMs);
    } else if (
      distance(previous.centre, shot.centre) < TIMING.keepZoomWithinPx ||
      shot.startMs - TIMING.zoomInMs < previous.endMs + TIMING.zoomOutMs
    ) {
      // Hold the previous target, then pan to this one; the pan may begin
      // inside the previous action, never before it.
      const fromMs = clamp(
        shot.startMs - TIMING.zoomInMs,
        previous.startMs,
        previous.endMs,
      );
      push(fromMs, previous.centre, previous.zoom);
      arriveMs = Math.max(arriveMs, fromMs + TIMING.minPanMs);
    } else {
      zoomOut(previous);
      push(shot.startMs - TIMING.zoomInMs, shot.centre, 1);
    }
    push(arriveMs, shot.centre, shot.zoom);
    previous = shot;
  }
  if (previous !== undefined) zoomOut(previous);
  return keys;
}

function centreOf(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * A blurred box over every masked field while it is on the page.
 *
 * A masked event that carries `maskVisibility` gets one span per interval: from
 * the interval's start (less the lead) to its end, or to the video's end when
 * the interval is open. Intervals may overlap for one step (a navigation that
 * leaves the field on screen); both boxes are masked then. Page scrolls that
 * start inside an interval move its box; the span does not end when the box
 * leaves the viewport, since the field is still on the page and may scroll back.
 *
 * A timeline from before `maskVisibility` has no intervals, so the old rule
 * stays: the mask runs from the event's start until a `navigate` ends, a page
 * scroll takes the box fully out of the viewport, or the video ends. It cannot
 * tell which click navigated, so covering too long is safe, too short a leak.
 */
function maskSpans(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  videoEndMs: number,
  leadMs: number,
): MaskSpan[] {
  const spans: MaskSpan[] = [];
  for (const [index, event] of events.entries()) {
    if (event.masked !== true) continue;
    if (event.maskVisibility !== undefined) {
      for (const interval of event.maskVisibility) {
        const startMs = Math.max(0, out(interval.startMs) - leadMs);
        const endMs =
          interval.endMs === undefined
            ? videoEndMs
            : Math.min(out(interval.endMs), videoEndMs);
        let box = grow(interval.box, TIMING.maskMarginPx);
        const keys: MaskSpan['keys'] = [{ atMs: startMs, box }];
        for (const later of events.slice(index + 1)) {
          const scroll = later.scroll;
          if (scroll === undefined || scroll.container !== undefined) continue;
          if (
            later.startMs < interval.startMs ||
            (interval.endMs !== undefined && later.startMs >= interval.endMs)
          ) {
            continue;
          }
          keys.push({ atMs: Math.min(out(later.startMs), endMs), box });
          box = {
            ...box,
            x: box.x - (scroll.after.x - scroll.before.x),
            y: box.y - (scroll.after.y - scroll.before.y),
          };
          keys.push({ atMs: Math.min(out(later.endMs), endMs), box });
        }
        spans.push({ startMs, endMs, keys });
      }
      continue;
    }
    if (event.target === undefined) continue;
    let box = grow(event.target.box, TIMING.maskMarginPx);
    const startMs = Math.max(0, out(event.startMs) - leadMs);
    const keys: MaskSpan['keys'] = [{ atMs: startMs, box }];
    let endMs = videoEndMs;
    for (const later of events.slice(index + 1)) {
      if (later.action === 'navigate') {
        endMs = out(later.endMs);
        break;
      }
      const scroll = later.scroll;
      // A container scroll moves what is inside it; the masked field is not assumed to be.
      if (scroll === undefined || scroll.container !== undefined) continue;
      keys.push({ atMs: out(later.startMs), box });
      box = {
        ...box,
        x: box.x - (scroll.after.x - scroll.before.x),
        y: box.y - (scroll.after.y - scroll.before.y),
      };
      keys.push({ atMs: out(later.endMs), box });
      if (!overlaps(box, viewport)) {
        endMs = out(later.endMs);
        break;
      }
    }
    spans.push({ startMs, endMs: Math.min(endMs, videoEndMs), keys });
  }
  return spans;
}

function grow(box: Box, by: number): Box {
  return {
    x: box.x - by,
    y: box.y - by,
    width: box.width + 2 * by,
    height: box.height + 2 * by,
  };
}

function overlaps(
  box: Box,
  viewport: { width: number; height: number },
): boolean {
  return (
    box.x < viewport.width &&
    box.y < viewport.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
}

/**
 * A lower-third for every step `caption` and `caption` marker, from the
 * step's start until 800 ms after its end. A later caption cuts an earlier one.
 */
function captions(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  videoEndMs: number,
): Caption[] {
  const list: Caption[] = events.flatMap((event) => {
    const text =
      event.marker?.kind === 'caption' ? event.marker.title : event.caption;
    if (text === undefined || text.trim() === '') return [];
    return [
      {
        startMs: out(event.startMs),
        endMs: Math.min(videoEndMs, out(event.endMs) + TIMING.captionTailMs),
        text,
      },
    ];
  });
  for (const [index, caption] of list.entries()) {
    const next = list[index + 1];
    if (next !== undefined) {
      caption.endMs = Math.min(caption.endMs, next.startMs);
    }
  }
  return list.filter((caption) => caption.endMs > caption.startMs);
}
