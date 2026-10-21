import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Box,
  FrameConfigSchema,
  type MaskInterval,
  type Navigation,
  type RenderFormat,
  type RunResult,
  RunResultSchema,
  type StepAction,
  type Timeline,
  type TimelineEvent,
  TimelineSchema,
} from '@demoflow/core';
import { resolveBackground } from './background.ts';
import { placeCards, shiftOverlays } from './cards.ts';
import { probeVideo } from './ffmpeg.ts';
import { findSyncClear, syncOffset } from './sync-mark.ts';
import {
  buildTimeMap,
  idleStretches,
  insertCards,
  toOutputMs,
} from './time-map.ts';
import { planHolds, shiftHolds, showsHeldPage } from './transitions.ts';
import type {
  CameraKeyframe,
  Caption,
  ClickRing,
  CursorMove,
  FailureSpec,
  FrameSpec,
  Interval,
  KeyBadge,
  MaskSpan,
  OutputFile,
  Point,
  RenderPlan,
  RenderPlanOptions,
  TransitionsSpec,
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
  /** A key badge stays this long after the press step ends. */
  keyTailMs: 600,
  endCardMs: 3_000,
  /** A target whose centre is closer than this to the previous one keeps the zoom and pans. */
  keepZoomWithinPx: 400,
  /** A pan never whips across in less than this. */
  minPanMs: 400,
  /** The engine waits up to this long for a navigation after the press. */
  pressToEndMs: 100,
  /** Masks start this early, to absorb the residual clock offset; one source frame when it is measured. */
  maskLeadMs: 200,
  /** Masks end this late, for the same reason: an early end leaks, a late one is safe (#48). */
  maskTrailMs: 200,
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
  'press',
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
  const maskTrailMs = offsetMeasured ? 1000 / source.fps : TIMING.maskTrailMs;
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
  const frameConfig = FrameConfigSchema.parse(options.frame ?? {});
  // The radius and margin are given at 1080p and follow the output height.
  const frame: FrameSpec | undefined = frameConfig.enabled
    ? {
        radius: (frameConfig.radius * output.height) / 1080,
        shadow: frameConfig.shadow,
        background: resolveBackground(
          options.background ?? { preset: 'ocean' },
        ),
      }
    : undefined;
  const fit =
    frame === undefined
      ? fitInto(viewport, output)
      : fitWindow(viewport, output, frameConfig.marginRatio * output.height);
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
  // Page time: the map before cards. Overlays are planned in it, then moved
  // past the cards, so no lead or trail is ever measured across a card.
  const pageMap = buildTimeMap(idle, sourceEndMs, compressToMs, startMs);
  const out = (timelineMs: number): number =>
    toOutputMs(pageMap, toSource(timelineMs));
  const pageEndMs = pageMap.at(-1)?.outputEndMs ?? 0;

  const cards = placeCards({
    ...(options.cards === undefined ? {} : { config: options.cards }),
    events,
    out,
    pageEndMs,
    scenarioName: result.scenarioName,
    ...(options.scenario?.description === undefined
      ? {}
      : { description: options.scenario.description }),
    failed: failure !== undefined,
  });
  const masks = maskSpans(events, out, viewport, pageEndMs, {
    leadMs: maskLeadMs,
    trailMs: maskTrailMs,
    navigations: timeline.navigations ?? [],
    transitions: options.transitions?.enabled === true,
    sourceFrameMs: 1000 / source.fps,
  });
  const overlays = shiftOverlays(
    {
      cursor: cursorMoves(events, out),
      clicks: clickRings(events, out),
      camera: cameraKeyframes(events, out, viewport, maxZoom),
      masks,
      captions: captions(events, out, pageEndMs),
      keys: keyBadges(events, out, pageEndMs, viewport),
    },
    cards,
  );
  const transitions: TransitionsSpec | undefined =
    options.transitions?.enabled === true
      ? {
          durationMs: options.transitions.durationMs,
          holds: shiftHolds(
            planHolds({
              navigations: timeline.navigations ?? [],
              events,
              out,
              toSource,
              sourceStartMs: pageMap[0]?.sourceStartMs ?? 0,
              pageEndMs,
              masks,
              sourceFrameMs: 1000 / source.fps,
              durationMs: options.transitions.durationMs,
            }),
            cards,
          ),
        }
      : undefined;
  const timeMap = insertCards(pageMap, cards);
  const videoEndMs = timeMap.at(-1)?.outputEndMs ?? 0;

  // No outro on a failed run (Decision 4): the end card follows the page.
  const failureSpec =
    failure === undefined
      ? undefined
      : failureCard(failure, videoEndMs, TIMING.endCardMs);

  return {
    version: 1,
    output: {
      ...output,
      files: outputFiles(output, options),
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
    fit,
    ...(frame === undefined ? {} : { frame }),
    offsetMs,
    offsetMeasured,
    maskLeadMs,
    maskTrailMs,
    durationMs: videoEndMs + (failureSpec?.endCard.durationMs ?? 0),
    timeMap,
    cards: cards.map(({ atMs: _, ...card }) => card),
    cardBackground:
      frame?.background ??
      resolveBackground(options.background ?? { preset: 'ocean' }),
    ...overlays,
    ...(transitions === undefined ? {} : { transitions }),
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

/** VP9 at constant quality (spec 133): measured on the fixture demo, see #133. */
const WEBM = { crf: 32, cpuUsed: 4 } as const;

/** The GIF defaults of spec 133, Decision 3. */
const GIF = { width: 800, fps: 12 } as const;

/** One file per requested format, in the order given; MP4 alone by default. */
function outputFiles(
  output: { width: number; height: number; fps: number },
  options: RenderPlanOptions,
): OutputFile[] {
  return (options.formats ?? ['mp4']).map((format) =>
    outputFile(format, output, options),
  );
}

function outputFile(
  format: RenderFormat,
  output: { width: number; height: number; fps: number },
  options: RenderPlanOptions,
): OutputFile {
  switch (format) {
    case 'mp4':
      return {
        format,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        faststart: true,
      };
    case 'webm':
      return { format, codec: 'vp9', pixelFormat: 'yuv420p', ...WEBM };
    case 'gif': {
      const width = options.gif?.width ?? Math.min(GIF.width, output.width);
      return {
        format,
        width,
        height: Math.max(
          2,
          Math.round((width * output.height) / output.width / 2) * 2,
        ),
        fps: options.gif?.fps ?? Math.min(GIF.fps, output.fps),
      };
    }
  }
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

/**
 * The window: the viewport fitted into the output less `margin` on every
 * side, centred, its corner on a whole pixel so its straight edges stay sharp.
 */
function fitWindow(
  viewport: { width: number; height: number },
  output: { width: number; height: number },
  margin: number,
): RenderPlan['fit'] {
  const scale = Math.min(
    (output.width - 2 * margin) / viewport.width,
    (output.height - 2 * margin) / viewport.height,
  );
  return {
    x: Math.round((output.width - viewport.width * scale) / 2),
    y: Math.round((output.height - viewport.height * scale) / 2),
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
 * the interval's start (less the lead) to its end (plus the trail), or to the
 * video's end when the interval is open. Intervals may overlap for one step (a navigation that
 * leaves the field on screen); both boxes are masked then. Page scrolls that
 * start inside an interval move its box; the span does not end when the box
 * leaves the viewport, since the field is still on the page and may scroll back.
 *
 * A timeline from before `maskVisibility` has no intervals, so the old rule
 * stays: the mask runs from the event's start until a `navigate` ends, a page
 * scroll takes the box fully out of the viewport, or the video ends.
 *
 * Either way, a document navigation (`timeline.navigations`, #114) then ends
 * the span when the old document leaves the screen, never earlier (spec 146):
 * see `documentEndMs`. An interval that overlaps a sibling (a navigation that
 * left the field on screen, #18) keeps its span as measured.
 *
 * A masked event with no box (its field could not be measured, #42) masks the
 * whole viewport from its start to the end of the video.
 */
function maskSpans(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  videoEndMs: number,
  {
    leadMs,
    trailMs,
    ...leaving
  }: {
    leadMs: number;
    trailMs: number;
    navigations: readonly Navigation[];
    transitions: boolean;
    sourceFrameMs: number;
  },
): MaskSpan[] {
  const documentEnd = (fromMs: number, endMs: number): number =>
    documentEndMs(fromMs, endMs, { ...leaving, out, trailMs, videoEndMs });
  const spans: MaskSpan[] = [];
  for (const [index, event] of events.entries()) {
    if (event.masked !== true) continue;
    if (event.maskVisibility !== undefined) {
      for (const interval of event.maskVisibility) {
        const startMs = Math.max(0, out(interval.startMs) - leadMs);
        const endMs =
          interval.endMs === undefined
            ? videoEndMs
            : Math.min(out(interval.endMs) + trailMs, videoEndMs);
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
        // The keys stay as measured: a hold reads the box at its start from them.
        spans.push({
          startMs,
          endMs: overlapsSibling(interval, event.maskVisibility)
            ? endMs
            : documentEnd(interval.startMs, endMs),
          keys,
        });
      }
      continue;
    }
    if (event.target === undefined) {
      // #42: a field that could not be measured; the whole viewport, to the end.
      spans.push(wholeViewport(event, out, viewport, videoEndMs, leadMs));
      continue;
    }
    let box = grow(event.target.box, TIMING.maskMarginPx);
    const startMs = Math.max(0, out(event.startMs) - leadMs);
    const keys: MaskSpan['keys'] = [{ atMs: startMs, box }];
    let endMs = videoEndMs;
    for (const later of events.slice(index + 1)) {
      if (later.action === 'navigate') {
        endMs = out(later.endMs) + trailMs;
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
        endMs = out(later.endMs) + trailMs;
        break;
      }
    }
    spans.push({
      startMs,
      endMs: documentEnd(event.startMs, Math.min(endMs, videoEndMs)),
      keys,
    });
  }
  return spans;
}

/**
 * When the document a mask's field was measured on leaves the screen (spec
 * 146), given the span's start in timeline ms and its end in page ms. The
 * first document navigation that starts after it governs, when the span is
 * still up on the frame before it starts (the frame a hold shows):
 *
 * - transitions on, and `planHolds` holds the old page for it
 *   (`showsHeldPage`): its start. The hold draws its own masks from there.
 * - otherwise (transitions off, the first navigation, a load past the page's
 *   end): its `endMs` plus the trail, since the old page stays on screen until
 *   the new one loads. This may lengthen the span as well as shorten it.
 * - a navigation still open at the end of the recording: the span as given.
 *
 * With no navigations (a timeline from before #114) the span is as given.
 */
function documentEndMs(
  fromMs: number,
  endMs: number,
  {
    navigations,
    transitions,
    sourceFrameMs,
    out,
    trailMs,
    videoEndMs,
  }: {
    navigations: readonly Navigation[];
    transitions: boolean;
    sourceFrameMs: number;
    out: (timelineMs: number) => number;
    trailMs: number;
    videoEndMs: number;
  },
): number {
  // Strictly after: a load that starts with the field's measure brings that document in.
  const index = navigations.findIndex(
    (navigation) => navigation.startMs > fromMs,
  );
  const navigation = navigations[index];
  if (navigation === undefined) return endMs;
  const leavesMs = out(navigation.startMs);
  // Gone before the navigation: the frame it starts on never showed it.
  if (endMs <= leavesMs - sourceFrameMs) return endMs;
  if (transitions && showsHeldPage(index, navigation, out, videoEndMs)) {
    return Math.min(endMs, leavesMs);
  }
  if (navigation.endMs === undefined) return endMs;
  return Math.min(out(navigation.endMs) + trailMs, videoEndMs);
}

/** Whether `interval` shares any time with another interval of the same field. */
function overlapsSibling(
  interval: MaskInterval,
  intervals: readonly MaskInterval[],
): boolean {
  const end = interval.endMs ?? Infinity;
  return intervals.some(
    (other) =>
      other !== interval &&
      other.startMs < end &&
      interval.startMs < (other.endMs ?? Infinity),
  );
}

function wholeViewport(
  event: TimelineEvent,
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  videoEndMs: number,
  leadMs: number,
): MaskSpan {
  const startMs = Math.max(0, out(event.startMs) - leadMs);
  const box = grow(
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    TIMING.maskMarginPx,
  );
  return { startMs, endMs: videoEndMs, keys: [{ atMs: startMs, box }] };
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
 * A badge naming the key of every `press`, hanging below its target — or, for
 * a press on the focused element, below where the pointer last rested (the
 * middle of the viewport before the first move). It shows from the step's
 * start until 600 ms after its end; a later badge cuts an earlier one.
 */
function keyBadges(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  videoEndMs: number,
  viewport: { width: number; height: number },
): KeyBadge[] {
  let rest: Point = { x: viewport.width / 2, y: viewport.height / 2 };
  const list: KeyBadge[] = [];
  for (const event of events) {
    if (event.pointer !== undefined) rest = event.pointer.to;
    if (event.action !== 'press' || event.key === undefined) continue;
    const anchor =
      event.target === undefined
        ? rest
        : {
            x: event.target.box.x + event.target.box.width / 2,
            y: event.target.box.y + event.target.box.height,
          };
    list.push({
      startMs: out(event.startMs),
      endMs: Math.min(videoEndMs, out(event.endMs) + TIMING.keyTailMs),
      text: event.key.split('+').join(' + '),
      anchor,
    });
  }
  for (const [index, badge] of list.entries()) {
    const next = list[index + 1];
    if (next !== undefined) badge.endMs = Math.min(badge.endMs, next.startMs);
  }
  return list.filter((badge) => badge.endMs > badge.startMs);
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
