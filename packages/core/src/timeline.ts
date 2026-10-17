import { z } from 'zod';
import { NonEmptyStringSchema, ViewportSchema } from './common.ts';
import { MarkerKindSchema, StepActionSchema } from './step.ts';

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
 * One executed step. Times are milliseconds from the video's first frame;
 * boxes and points are CSS pixels of the viewport (ADR-0004 §1).
 */
export const TimelineEventSchema = z
  .strictObject({
    stepIndex: z.number().int().nonnegative(),
    action: StepActionSchema,
    startMs: msSchema,
    endMs: msSchema,
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
    // Relative to the run directory.
    screenshot: NonEmptyStringSchema.optional(),
    marker: z
      .strictObject({ title: NonEmptyStringSchema, kind: MarkerKindSchema })
      .optional(),
    caption: z.string().optional(),
    error: z.strictObject({ message: z.string() }).optional(),
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
  );
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/** `timeline.json`, written by the engine beside the source video. */
export const TimelineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  viewport: ViewportSchema,
  deviceScaleFactor: z.number().positive(),
  videoFile: NonEmptyStringSchema,
  events: z.array(TimelineEventSchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;
