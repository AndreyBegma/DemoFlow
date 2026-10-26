import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Annotation,
  type Box,
  checkRunEdits,
  FrameConfigSchema,
  formatPath,
  type RenderFormat,
  RUN_EDITS_FILE,
  type RunEdits,
  RunEditsSchema,
  type RunResult,
  RunResultSchema,
  SquareConfigSchema,
  type StepAction,
  type Timeline,
  type TimelineEvent,
  TimelineSchema,
  VerticalConfigSchema,
} from '@demoflow/core';
import { resolveBackground } from './background.ts';
import { placeCards, shiftOverlays } from './cards.ts';
import { probeVideo } from './ffmpeg.ts';
import { cropSize } from './frame.ts';
import { measuredMaskMarginMs } from './mask-margin.ts';
import { maskSpans } from './masks.ts';
import { findSyncClear, syncOffset } from './sync-mark.ts';
import {
  buildTimeMap,
  idleStretches,
  insertCards,
  toOutputMs,
} from './time-map.ts';
import { planHolds, shiftHolds } from './transitions.ts';
import type {
  CameraKeyframe,
  Caption,
  ClickRing,
  CropSpec,
  CursorMove,
  FailureSpec,
  FollowKey,
  FrameSpec,
  Highlight,
  Interval,
  KeyBadge,
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
  /** Optional: a run without it renders as recorded (ADR-0020 §1). */
  edits: RUN_EDITS_FILE,
} as const;

/** The Playwright video leads the engine clock by ~100 ms (#3, measured −90…−123 ms). */
export const DEFAULT_OFFSET_MS = -100;

export const DEFAULTS = {
  idleThresholdMs: 1_000,
  idleCompressToMs: 400,
  output: { width: 1920, height: 1080, fps: 30 },
  /** `render.endHoldMs`'s default (spec 365). */
  endHoldMs: 2_500,
  /** What `zoom: true` means on a source with at least two pixels per CSS pixel (ADR-0012). */
  zoom: 1.35,
  /** Zoom on a 1× source: past the source pixels already, so kept gentle (spec 4, Risks). */
  zoomOnLowResSource: 1.25,
} as const;

/** Spec 4, Decisions. */
const TIMING = {
  clickRingMs: 300,
  zoomInMs: 500,
  zoomOutMs: 400,
  captionTailMs: 800,
  /** A caption the page set stays this long, unless the next caption cuts it (spec 201). */
  pageCaptionMs: 3_000,
  /** A key badge stays this long after the press step ends. */
  keyTailMs: 600,
  endCardMs: 3_000,
  /** A target whose centre is closer than this to the previous one keeps the zoom and pans. */
  keepZoomWithinPx: 400,
  /** A pan never whips across in less than this. */
  minPanMs: 400,
  /** The engine waits up to this long for a navigation after the press. */
  pressToEndMs: 100,
  /** Masks start this early, to absorb the residual clock offset; `measuredMaskMarginMs` when it is measured. */
  maskLeadMs: 200,
  /** Masks end this late, for the same reason: an early end leaks, a late one is safe (#48). */
  maskTrailMs: 200,
  /** An asserted element's outline fades in over this long (spec 365). */
  highlightFadeMs: 200,
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

/** Steps whose `zoom` stays on the element through the hold, outlined (spec 365, Decision 5). */
const ASSERTIONS: ReadonlySet<StepAction> = new Set([
  'assertVisible',
  'assertText',
]);

export interface PlanInput {
  timeline: Timeline;
  result: RunResult;
  /** The source video, probed for frozen stretches at the idle threshold. */
  source: VideoProbe;
  /** The source time of the first frame after `timeline.syncMark`, when it was found. */
  syncClearMs?: number;
  /** The run's `edits.json`, already checked against the timeline (spec 353). */
  edits?: RunEdits;
}

/**
 * Reads a run directory and plans its video: `timeline.json`, `result.json`,
 * `edits.json` when there is one, one FFmpeg pass over the source (size,
 * frame rate, frozen stretches) and, when the timeline has a sync mark, one
 * over its start to find the mark. Edits that fail their schema or do not fit
 * the timeline fail the plan: a render that drops them would look like a bug.
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
  const edits = await readEdits(
    path.join(runDir, PLAN_INPUTS.edits),
    timeline,
    result,
    options.endHoldMs ?? DEFAULTS.endHoldMs,
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
      ...(edits === undefined ? {} : { edits }),
    },
    options,
  );
}

/** The run's edits, or `undefined` when it has no `edits.json`. */
async function readEdits(
  file: string,
  timeline: Timeline,
  result: RunResult,
  tailMs: number,
): Promise<RunEdits | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const name = PLAN_INPUTS.edits;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${(error as Error).message}`);
  }
  const parsed = RunEditsSchema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(
      `${name} is invalid at ${formatPath(issue.path) || '(root)'}: ${issue.message}`,
    );
  }
  const [issue] = checkRunEdits(parsed.data, timeline, result, {
    tailMs,
  });
  if (issue !== undefined) {
    throw new Error(
      `${name} does not fit the run at ${issue.path}: ${issue.message}`,
    );
  }
  return parsed.data;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The render plan of a run, without touching the disk (spec 4, Decisions). */
export function planRender(
  input: PlanInput,
  options: RenderPlanOptions = {},
): RenderPlan {
  const { timeline, result, source, edits } = input;
  // Measured on the sync mark when it was found (#19); otherwise the defaults.
  const measuredMs =
    timeline.syncMark === undefined
      ? undefined
      : syncOffset(timeline.syncMark, input.syncClearMs);
  const offsetMs = options.offsetMs ?? measuredMs ?? DEFAULT_OFFSET_MS;
  const offsetMeasured =
    options.offsetMs === undefined && measuredMs !== undefined;
  const maskLeadMs = offsetMeasured
    ? measuredMaskMarginMs(source.fps)
    : TIMING.maskLeadMs;
  const maskTrailMs = offsetMeasured
    ? measuredMaskMarginMs(source.fps)
    : TIMING.maskTrailMs;
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
  // Edited style: the background replaces the config's, the window's fields
  // replace the config's one by one (spec 353, Decision 5).
  const frameConfig = FrameConfigSchema.parse({
    ...options.frame,
    ...edits?.frame,
  });
  const background = edits?.background ??
    options.background ?? { preset: 'ocean' };
  // The radius and margin are given at 1080p and follow the output height.
  const frame: FrameSpec | undefined = frameConfig.enabled
    ? {
        radius: (frameConfig.radius * output.height) / 1080,
        shadow: frameConfig.shadow,
        background: resolveBackground(background),
      }
    : undefined;
  const fit =
    frame === undefined
      ? fitInto(viewport, output)
      : fitWindow(viewport, output, frameConfig.marginRatio * output.height);
  const sourceScale = source.width / viewport.width;
  // What a step's `zoom: true` resolves to; a number on the step overrides it.
  const defaultZoom =
    options.zoom ??
    (sourceScale >= 2 ? DEFAULTS.zoom : DEFAULTS.zoomOnLowResSource);

  const events = withZoomEdits(timeline.events, edits?.zoom ?? []);
  const failure = failedStage(result);
  const toSource = (timelineMs: number): number =>
    clamp(timelineMs + offsetMs, 0, source.durationMs);

  // The video ends at the failure, or `endHoldMs` after the last event and
  // its hold (spec 365). A source that ends sooner, as one recorded before
  // the end hold did, ends it sooner: `toSource` clamps (Decision 6).
  const failedEvent =
    failure?.stepIndex === undefined
      ? undefined
      : events.find((event) => event.stepIndex === failure.stepIndex);
  const lastEvent = events.at(-1);
  const endHoldMs =
    failure === undefined ? (options.endHoldMs ?? DEFAULTS.endHoldMs) : 0;
  // Timeline time each event stays on screen until: its hold, and the end
  // hold after the last.
  const shownUntil = (event: TimelineEvent): number =>
    heldUntil(event) + (event === lastEvent ? endHoldMs : 0);
  const sourceEndMs =
    failure !== undefined
      ? toSource(failedEvent?.endMs ?? lastEvent?.endMs ?? source.durationMs)
      : lastEvent === undefined
        ? source.durationMs
        : toSource(shownUntil(lastEvent));

  // A hold is never idle: a page frozen on its result plays at 1:1 (Decision 3).
  const active: Interval[] = events.flatMap((event) => [
    ...(ACTIVE.has(event.action)
      ? [{ startMs: toSource(event.startMs), endMs: toSource(event.endMs) }]
      : []),
    ...(shownUntil(event) > event.endMs
      ? [{ startMs: toSource(event.endMs), endMs: toSource(shownUntil(event)) }]
      : []),
  ]);
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
    annotations: timeline.annotations ?? [],
    out,
    pageEndMs,
    scenarioName: result.scenarioName,
    ...(options.scenario?.description === undefined
      ? {}
      : { description: options.scenario.description }),
    failed: failure !== undefined,
    ...(edits?.cards === undefined ? {} : { edits: edits.cards }),
  });
  const masks = maskSpans(events, out, viewport, pageEndMs, {
    leadMs: maskLeadMs,
    trailMs: maskTrailMs,
    maskedElements: timeline.maskedElements ?? [],
    navigations: timeline.navigations ?? [],
    transitions: options.transitions?.enabled === true,
    sourceFrameMs: 1000 / source.fps,
  });
  const cardBackground = frame?.background ?? resolveBackground(background);
  const verticalConfig = VerticalConfigSchema.parse(options.vertical ?? {});
  const squareConfig = SquareConfigSchema.parse(options.square ?? {});
  const { follow, squareFollow, ...overlays } = shiftOverlays(
    {
      // A phone has no mouse pointer: the click ring is the tap (spec 307).
      cursor: timeline.device === 'phone' ? [] : cursorMoves(events, out),
      clicks: clickRings(events, out),
      highlights: highlights(
        events,
        out,
        shownUntil,
        pageEndMs,
        cardBackground.to,
      ),
      camera: cameraKeyframes(events, out, viewport, defaultZoom, shownUntil),
      follow: followKeys(
        events,
        out,
        viewport,
        cropSize(viewport, VERTICAL),
        verticalConfig,
      ),
      squareFollow: followKeys(
        events,
        out,
        viewport,
        cropSize(viewport, SQUARE),
        squareConfig,
      ),
      masks,
      captions:
        edits?.captions === undefined
          ? captions(events, timeline.annotations ?? [], out, pageEndMs)
          : editedCaptions(edits.captions, out, pageEndMs),
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
              maskLeadMs,
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
  const files = outputFiles(output, options);
  const vertical: CropSpec | undefined = files.some((file) =>
    file.format.endsWith('-vertical'),
  )
    ? {
        width: VERTICAL.width,
        height: VERTICAL.height,
        follow,
        caption: cropCaption(VERTICAL, verticalConfig.captionBand),
      }
    : undefined;
  const square: CropSpec | undefined = files.some((file) =>
    file.format.endsWith('-square'),
  )
    ? {
        width: SQUARE.width,
        height: SQUARE.height,
        follow: squareFollow,
        caption: cropCaption(SQUARE, squareConfig.captionBand),
      }
    : undefined;

  return {
    version: 1,
    output: { ...output, files },
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
    cardBackground,
    ...overlays,
    ...(transitions === undefined ? {} : { transitions }),
    ...(failureSpec === undefined ? {} : { failure: failureSpec }),
    ...(vertical === undefined ? {} : { vertical }),
    ...(square === undefined ? {} : { square }),
  };
}

/** Each event's `zoom` replaced by its edit (spec 353, Decision 3). */
function withZoomEdits(
  events: readonly TimelineEvent[],
  zoom: NonNullable<RunEdits['zoom']>,
): readonly TimelineEvent[] {
  if (zoom.length === 0) return events;
  const byStep = new Map(zoom.map((entry) => [entry.stepIndex, entry.zoom]));
  return events.map((event) => {
    const edited = byStep.get(event.stepIndex);
    return edited === undefined ? event : { ...event, zoom: edited };
  });
}

/** The vertical output's size and caption type (spec 176, Decisions 1 and 4). */
export const VERTICAL = {
  width: 1080,
  height: 1920,
  /** At 1080 wide; at least the 44 px Decision 4 asks for. */
  captionFontPx: 48,
  captionMaxLines: 3,
} as const;

/** The square output's size and caption type (spec 304, Decisions 2 and 6). */
export const SQUARE = {
  width: 1080,
  height: 1080,
  captionFontPx: 48,
  captionMaxLines: 2,
} as const;

/** The band over the bottom `band` of a crop's frame, the type scaled with its width. */
function cropCaption(
  size: typeof VERTICAL | typeof SQUARE,
  band: number,
): CropSpec['caption'] {
  const height = Math.round(size.height * band);
  return {
    top: size.height - height,
    height,
    fontPx: (size.captionFontPx * size.width) / 1080,
    maxLines: size.captionMaxLines,
  };
}

/**
 * The crop's centre (spec 176, Decision 3; spec 306, Decision 1): the page
 * centre at the start, then the centre of each step's target, reached as the
 * step starts — or as soon as the previous move ends — over `followMs`. A
 * step without a target keeps it. A move is skipped only when both axes move
 * under `deadZone` of the crop's width (across) and height (down), measured
 * where the clamped crop would actually go. The keys hold the target itself;
 * the crop is clamped to the page when drawn, so a zoom on an edge target
 * still centres it as far as the page allows.
 */
function followKeys(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  crop: { width: number; height: number },
  { followMs, deadZone }: { followMs: number; deadZone: number },
): FollowKey[] {
  const onPage = (point: Point): Point => ({
    x: clampAxis(point.x, crop.width, viewport.width),
    y: clampAxis(point.y, crop.height, viewport.height),
  });
  let at: Point = { x: viewport.width / 2, y: viewport.height / 2 };
  const keys: FollowKey[] = [{ atMs: 0, ...at }];
  for (const event of events) {
    if (event.target === undefined) continue;
    const to = centreOf(event.target.box);
    const from = onPage(at);
    const next = onPage(to);
    if (
      Math.abs(next.x - from.x) < deadZone * crop.width &&
      Math.abs(next.y - from.y) < deadZone * crop.height
    ) {
      continue;
    }
    const last = keys[keys.length - 1].atMs;
    const startMs = Math.max(last, out(event.startMs) - followMs);
    keys.push({ atMs: startMs, ...at }, { atMs: startMs + followMs, ...to });
    at = to;
  }
  return keys;
}

/** A crop centre on one axis, kept where a crop of `size` stays inside `extent`. */
function clampAxis(value: number, size: number, extent: number): number {
  const half = size / 2;
  return clamp(value, half, Math.max(half, extent - half));
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
    case 'mp4-vertical':
    case 'mp4-square':
      return {
        format,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        faststart: true,
      };
    case 'webm':
    case 'webm-vertical':
    case 'webm-square':
      return { format, codec: 'vp9', pixelFormat: 'yuv420p', ...WEBM };
    case 'gif-square': {
      // Three quarters of `gif.width` a side: the landscape GIF's pixels per frame (spec 304).
      const width = options.gif?.width ?? Math.min(GIF.width, output.width);
      const side = Math.max(2, Math.round((width * 3) / 4 / 2) * 2);
      return {
        format,
        width: side,
        height: side,
        fps: options.gif?.fps ?? Math.min(GIF.fps, output.fps),
      };
    }
    case 'gif-vertical': {
      // The height is `gif.width`, so a frame has the landscape GIF's pixels (spec 236).
      const height = options.gif?.width ?? Math.min(GIF.width, VERTICAL.height);
      return {
        format,
        width: Math.max(2, Math.round((height * 9) / 16 / 2) * 2),
        height,
        fps: options.gif?.fps ?? Math.min(GIF.fps, output.fps),
      };
    }
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

/** The end of an event's hold, or of the event itself without one. */
function heldUntil(event: TimelineEvent): number {
  return event.endMs + (event.holdMs ?? 0);
}

/** Whether the step asked for a zoom (ADR-0012): `true`, or a strength above 1. */
function asksForZoom(event: TimelineEvent): boolean {
  return (
    event.zoom === true || (typeof event.zoom === 'number' && event.zoom > 1)
  );
}

/**
 * An outline around the element of every assertion with `zoom`, from the end
 * of the assertion for as long as its hold keeps it on screen (spec 365,
 * Decision 5).
 */
function highlights(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  shownUntil: (event: TimelineEvent) => number,
  videoEndMs: number,
  colour: string,
): Highlight[] {
  return events.flatMap((event) => {
    if (
      !ASSERTIONS.has(event.action) ||
      event.target === undefined ||
      !asksForZoom(event)
    ) {
      return [];
    }
    const startMs = out(event.endMs);
    const endMs = Math.min(videoEndMs, out(shownUntil(event)));
    return endMs > startMs
      ? [
          {
            startMs,
            endMs,
            box: event.target.box,
            colour,
            fadeMs: TIMING.highlightFadeMs,
          },
        ]
      : [];
  });
}

interface Shot {
  /** The action itself: the press of a click, the whole of a fill or select. */
  startMs: number;
  endMs: number;
  centre: Point;
  zoom: number;
}

/**
 * Zoom on the target of every step that asks for it (ADR-0012): in over 500 ms
 * before the action, out over 400 ms after. A target near the previous one,
 * or one whose zoom-in would start before the previous zoom-out ends, keeps
 * the zoom and pans instead. A targeted step without zoom between them ends
 * the zoom; a step without a target (a wait, a marker) leaves it to that rule.
 */
function cameraKeyframes(
  events: readonly TimelineEvent[],
  out: (timelineMs: number) => number,
  viewport: { width: number; height: number },
  defaultZoom: number,
  shownUntil: (event: TimelineEvent) => number,
): CameraKeyframe[] {
  // `null`: a targeted step that does not zoom.
  const shots: (Shot | null)[] = events.flatMap((event) => {
    if (event.target === undefined) return [];
    const strength =
      event.zoom === true
        ? defaultZoom
        : event.zoom === false
          ? 1
          : (event.zoom ?? 1);
    const { box } = event.target;
    const zoom = Math.max(
      1,
      Math.min(
        strength,
        (TIMING.targetFill * viewport.width) / Math.max(box.width, 1),
        (TIMING.targetFill * viewport.height) / Math.max(box.height, 1),
      ),
    );
    if (zoom === 1) return [null];
    // A click and a press zoom for the moment of the press; an assertion
    // stays on its element through its hold (spec 365, Decision 5).
    const action =
      event.action === 'click' || event.action === 'press'
        ? { startMs: out(pressMs(event)), endMs: out(pressMs(event)) }
        : {
            startMs: out(event.startMs),
            endMs: out(
              ASSERTIONS.has(event.action) ? shownUntil(event) : event.endMs,
            ),
          };
    return [{ ...action, centre: centreOf(box), zoom }];
  });

  const keys: CameraKeyframe[] = [];
  const push = (atMs: number, centre: Point, zoom: number): void => {
    const last = keys.at(-1);
    keys.push({ atMs: Math.max(atMs, last?.atMs ?? 0, 0), centre, zoom });
  };
  // Out over 400 ms from the action's end, or from a late arrival: a zoom
  // that eased in after its action still eases out instead of snapping.
  const zoomOut = (shot: Shot): void => {
    push(shot.endMs, shot.centre, shot.zoom);
    const heldMs = keys.at(-1)?.atMs ?? shot.endMs;
    push(heldMs + TIMING.zoomOutMs, shot.centre, 1);
  };
  let previous: Shot | undefined;
  for (const shot of shots) {
    if (shot === null) {
      if (previous !== undefined) zoomOut(previous);
      previous = undefined;
      continue;
    }
    // The camera arrives as the action starts, or later when it has no room to
    // ease: a shot in the first 500 ms, a pan right after the previous action,
    // a zoom-in that would start before the last zoom-out ends.
    let arriveMs = shot.startMs;
    if (previous === undefined) {
      const fromMs = Math.max(
        0,
        shot.startMs - TIMING.zoomInMs,
        keys.at(-1)?.atMs ?? 0,
      );
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
 * step's start until 800 ms after its end, and for every `caption` the page
 * set (#201), for 3 s from the call. A later caption cuts an earlier one,
 * whichever source it came from.
 */
function captions(
  events: readonly TimelineEvent[],
  annotations: readonly Annotation[],
  out: (timelineMs: number) => number,
  videoEndMs: number,
): Caption[] {
  const fromPage: Caption[] = annotations.flatMap((annotation) =>
    annotation.kind === 'caption'
      ? [
          {
            startMs: out(annotation.atMs),
            endMs: Math.min(
              videoEndMs,
              out(annotation.atMs) + TIMING.pageCaptionMs,
            ),
            text: annotation.title,
          },
        ]
      : [],
  );
  const fromSteps: Caption[] = events.flatMap((event) => {
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
  // Stable: at an equal start a step's caption comes before the page's.
  const list = [...fromSteps, ...fromPage].sort(
    (a, b) => a.startMs - b.startMs,
  );
  for (const [index, caption] of list.entries()) {
    const next = list[index + 1];
    if (next !== undefined) {
      caption.endMs = Math.min(caption.endMs, next.startMs);
    }
  }
  return list.filter((caption) => caption.endMs > caption.startMs);
}

/**
 * The edited caption list in place of every step and page caption (spec 353,
 * Decision 2): each at its own times, kept within the page. The list is
 * ordered and does not overlap, so no caption cuts another.
 */
function editedCaptions(
  list: NonNullable<RunEdits['captions']>,
  out: (timelineMs: number) => number,
  videoEndMs: number,
): Caption[] {
  return list.flatMap((caption) => {
    const startMs = out(caption.startMs);
    const endMs = Math.min(videoEndMs, out(caption.endMs));
    return endMs > startMs ? [{ startMs, endMs, text: caption.text }] : [];
  });
}
