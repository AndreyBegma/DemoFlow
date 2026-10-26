import { z } from 'zod';
import { NonEmptyStringSchema, ViewportSchema } from './common.ts';
import { DeviceSchema } from './scenario.ts';
import { MarkerKindSchema, StepActionSchema, ZoomSchema } from './step.ts';

/** The value a masked `fill` writes to the timeline instead of the secret. */
export const MASKED_VALUE = '***';

const PointSchema = z.strictObject({ x: z.number(), y: z.number() });

const BoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type Box = z.infer<typeof BoxSchema>;

const msSchema = z.number().nonnegative();

/**
 * Where an expanded step came from (spec 165): the `repeat` at
 * `steps[repeatIndex]` of the scenario, in its 0-based `iteration`.
 */
export const StepOriginSchema = z.strictObject({
  repeatIndex: z.number().int().nonnegative(),
  iteration: z.number().int().nonnegative(),
});
export type StepOrigin = z.infer<typeof StepOriginSchema>;

/** A stretch of time a masked field was on the page, and where it was then. */
const MaskIntervalSchema = z
  .strictObject({
    startMs: msSchema,
    // Absent: still on the page when the run ended.
    endMs: msSchema.optional(),
    box: BoxSchema,
  })
  .refine((interval) => (interval.endMs ?? Infinity) >= interval.startMs, {
    message: 'expected endMs to be at or after startMs',
    path: ['endMs'],
  });
export type MaskInterval = z.infer<typeof MaskIntervalSchema>;

/**
 * Ordered by `startMs`; only the last may be open. An interval may start
 * before the previous one ends only when that one is closed: a navigation
 * that leaves the field on screen ends the old box and starts the new one
 * within the same step (#18).
 */
const MaskVisibilitySchema = z
  .array(MaskIntervalSchema)
  .superRefine((intervals, ctx) => {
    for (const [index, interval] of intervals.entries()) {
      const previous = intervals[index - 1];
      if (previous === undefined) continue;
      if (previous.endMs === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected only the last interval to be open',
          path: [index - 1, 'endMs'],
        });
      } else if (interval.startMs < previous.startMs) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected intervals ordered by startMs',
          path: [index, 'startMs'],
        });
      }
    }
  });
export type MaskVisibility = z.infer<typeof MaskVisibilitySchema>;

/**
 * An element the application marked with `data-demoflow-mask` (ADR-0013 §2):
 * when it was on screen, and its border box then. A box that moves starts a
 * new interval, one frame before the old one ends (#197).
 */
const MaskedElementSchema = z.strictObject({
  intervals: MaskVisibilitySchema.min(1),
});
export type MaskedElement = z.infer<typeof MaskedElementSchema>;

/**
 * A main-frame document navigation: from its request to the page's `load`
 * (#114). Absent `endMs`: still loading when the recording ended.
 */
const NavigationSchema = z
  .strictObject({
    startMs: msSchema,
    endMs: msSchema.optional(),
  })
  .refine((navigation) => (navigation.endMs ?? Infinity) > navigation.startMs, {
    message: 'expected endMs to be after startMs',
    path: ['endMs'],
  });
export type Navigation = z.infer<typeof NavigationSchema>;

/** Ordered and non-overlapping; only the last may be open. */
const NavigationsSchema = z
  .array(NavigationSchema)
  .superRefine((navigations, ctx) => {
    for (const [index, navigation] of navigations.entries()) {
      const previous = navigations[index - 1];
      if (previous === undefined) continue;
      if (previous.endMs === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected only the last navigation to be open',
          path: [index - 1, 'endMs'],
        });
      } else if (navigation.startMs < previous.endMs) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected navigations ordered and not overlapping',
          path: [index, 'startMs'],
        });
      }
    }
  });

/**
 * A scene or caption the application set from the page, through
 * `window.demoflow` (ADR-0014): when the engine received it, and its text.
 */
const AnnotationSchema = z.strictObject({
  atMs: msSchema,
  kind: MarkerKindSchema,
  title: z.string().trim().min(1).max(120),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** In non-decreasing `atMs`. */
const AnnotationsSchema = z
  .array(AnnotationSchema)
  .superRefine((annotations, ctx) => {
    for (const [index, annotation] of annotations.entries()) {
      const previous = annotations[index - 1];
      if (previous !== undefined && annotation.atMs < previous.atMs) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected annotations ordered by atMs',
          path: [index, 'atMs'],
        });
      }
    }
  });

/**
 * One executed step. Times are milliseconds from the video's first frame;
 * boxes and points are CSS pixels of the viewport (ADR-0004 §1).
 */
export const TimelineEventSchema = z
  .strictObject({
    // Counts expanded steps: a `repeat` adds one per step per iteration.
    stepIndex: z.number().int().nonnegative(),
    // Only on a step that came from a `repeat`.
    origin: StepOriginSchema.optional(),
    action: StepActionSchema,
    startMs: msSchema,
    // The end of the action; a `hold` follows it (spec 365).
    endMs: msSchema,
    // The step's `hold`, slept after `endMs`: `[endMs, endMs + holdMs]` is on screen.
    holdMs: z.number().int().positive().optional(),
    target: z.strictObject({ box: BoxSchema }).optional(),
    // The real pointer path (ADR-0004 §2).
    pointer: z.strictObject({ from: PointSchema, to: PointSchema }).optional(),
    scroll: z
      .strictObject({
        before: PointSchema,
        after: PointSchema,
        container: BoxSchema.optional(),
      })
      .optional(),
    // A `fill` from `valueFrom.env`.
    masked: z.boolean().optional(),
    // `***` when masked; omitted for anything but `fill`.
    value: z.string().optional(),
    assertion: z
      .strictObject({ passed: z.boolean(), message: z.string().optional() })
      .optional(),
    // The key a `press` sent, as written in the scenario.
    key: NonEmptyStringSchema.optional(),
    // Relative to the run directory.
    screenshot: NonEmptyStringSchema.optional(),
    marker: z
      .strictObject({ title: NonEmptyStringSchema, kind: MarkerKindSchema })
      .optional(),
    caption: z.string().optional(),
    // The step's `zoom`, verbatim: the renderer resolves `true` (ADR-0012).
    zoom: ZoomSchema.optional(),
    error: z.strictObject({ message: z.string() }).optional(),
    // Only on a masked `fill`: when its field was on the page (ADR-0004; #18).
    maskVisibility: MaskVisibilitySchema.optional(),
  })
  .refine((event) => event.endMs >= event.startMs, {
    message: 'expected endMs to be at or after startMs',
    path: ['endMs'],
  })
  .refine(
    (event) =>
      event.masked !== true ||
      event.value === undefined ||
      event.value === MASKED_VALUE,
    {
      message: `expected a masked value to be written as ${MASKED_VALUE}`,
      path: ['value'],
    },
  )
  .refine((event) => event.key === undefined || event.action === 'press', {
    message: 'expected key only on a press event',
    path: ['key'],
  })
  .refine(
    (event) => event.maskVisibility === undefined || event.masked === true,
    {
      message: 'expected maskVisibility only on a masked event',
      path: ['maskVisibility'],
    },
  );
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/** `timeline.json`, written by the engine beside the source video. */
export const TimelineSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    viewport: ViewportSchema,
    deviceScaleFactor: z.number().positive(),
    // Absent in timelines written before spec 305: the renderer reads it as "desktop".
    device: DeviceSchema.optional(),
    videoFile: NonEmptyStringSchema,
    events: z.array(TimelineEventSchema),
    // Painted at clock zero, cleared before step 0; the renderer measures the
    // video/clock offset from it (#19).
    syncMark: z
      .strictObject({
        colour: z.string().regex(/^#[0-9a-f]{6}$/),
        onMs: msSchema,
        offMs: msSchema,
      })
      .refine((mark) => mark.offMs > mark.onMs, {
        message: 'expected offMs to be after onMs',
        path: ['offMs'],
      })
      .optional(),
    // Document navigations only: a same-document route change has no blank page (#114).
    navigations: NavigationsSchema.optional(),
    // One per marked element, in the order they first appeared; omitted when none was (#197).
    maskedElements: z.array(MaskedElementSchema).optional(),
    // Scenes and captions the page set, by engine time; omitted when none was (#201).
    annotations: AnnotationsSchema.optional(),
  })
  .refine(
    (timeline) => {
      const first = timeline.events[0];
      return (
        timeline.syncMark === undefined ||
        first === undefined ||
        timeline.syncMark.offMs <= first.startMs
      );
    },
    {
      message: 'expected the sync mark to be cleared before the first event',
      path: ['syncMark', 'offMs'],
    },
  );
export type Timeline = z.infer<typeof TimelineSchema>;
