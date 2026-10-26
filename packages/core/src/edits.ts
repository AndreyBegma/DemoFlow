import { z } from 'zod';
import type { Issue } from './issues.ts';
import {
  BackgroundConfigSchema,
  CardTextSchema,
  FrameConfigSchema,
} from './project-config.ts';
import { ZoomSchema } from './step.ts';
import type { Timeline } from './timeline.ts';

/** The edits of a run, beside `timeline.json` in its directory (ADR-0020 §1). */
export const RUN_EDITS_FILE = 'edits.json';

/** `render.endHoldMs`'s default: the tail a caption may reach into when none is given (spec 365). */
const DEFAULT_TAIL_MS = 2_500;

/** Timeline milliseconds: the engine clock of `timeline.json` (ADR-0020 §1). */
const msSchema = z.number().int().nonnegative();

const MAX_CAPTIONS = 200;

const EditedCaptionSchema = z
  .strictObject({
    startMs: msSchema,
    endMs: msSchema,
    // The limit of a caption the page sets (ADR-0014).
    text: z.string().trim().min(1).max(120),
  })
  .refine((caption) => caption.endMs > caption.startMs, {
    message: 'expected endMs to be after startMs',
    path: ['endMs'],
  });

/** Ordered by `startMs` and not overlapping. */
const EditedCaptionsSchema = z
  .array(EditedCaptionSchema)
  .max(MAX_CAPTIONS)
  .superRefine((captions, ctx) => {
    for (const [index, caption] of captions.entries()) {
      const previous = captions[index - 1];
      if (previous !== undefined && caption.startMs < previous.endMs) {
        ctx.addIssue({
          code: 'custom',
          message: 'expected captions ordered by startMs and not overlapping',
          path: [index, 'startMs'],
        });
      }
    }
  });

/** At most one entry per step. */
const ZoomEditsSchema = z
  .array(
    z.strictObject({
      stepIndex: z.number().int().nonnegative(),
      zoom: ZoomSchema,
    }),
  )
  .superRefine((entries, ctx) => {
    const seen = new Set<number>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.stepIndex)) {
        ctx.addIssue({
          code: 'custom',
          message: `expected one zoom per step; step ${entry.stepIndex} is listed twice`,
          path: [index, 'stepIndex'],
        });
      }
      seen.add(entry.stepIndex);
    }
  });

const frameFields = FrameConfigSchema.unwrap().shape;

/**
 * `edits.json` (spec 353): what the person changed on the website, applied by
 * the renderer over the run's timeline and the project's `render.*`. Anything
 * absent renders as configured.
 */
export const RunEditsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  // The complete caption list when present: it replaces the captions of the
  // steps and of the page. `[]` means none.
  captions: EditedCaptionsSchema.optional(),
  // A step not listed keeps its timeline `zoom`.
  zoom: ZoomEditsSchema.optional(),
  cards: z
    .strictObject({
      intro: z
        .strictObject({
          enabled: z.boolean().optional(),
          title: CardTextSchema.optional(),
          // `null` removes the description from the card.
          subtitle: CardTextSchema.nullable().optional(),
        })
        .optional(),
      scenes: z.strictObject({ enabled: z.boolean().optional() }).optional(),
      // An object is the outro, even when the config has none; `null` removes it.
      outro: z
        .strictObject({
          title: CardTextSchema,
          cta: CardTextSchema.optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  background: BackgroundConfigSchema.optional(),
  frame: z
    .strictObject({
      enabled: frameFields.enabled.removeDefault().optional(),
      radius: frameFields.radius.removeDefault().optional(),
      shadow: frameFields.shadow.removeDefault().optional(),
    })
    .optional(),
});
export type RunEdits = z.infer<typeof RunEditsSchema>;

/**
 * Checks parsed edits against the run's timeline (spec 353): a zoom only on a
 * step whose event has a target box (ADR-0012 §2), and no caption past the
 * end of the video. `tailMs` is the end hold the renderer keeps after the
 * last event and its hold (`render.endHoldMs`).
 */
export function checkRunEdits(
  edits: RunEdits,
  timeline: Timeline,
  { tailMs = DEFAULT_TAIL_MS }: { tailMs?: number } = {},
): Issue[] {
  const issues: Issue[] = [];
  const events = new Map(
    timeline.events.map((event) => [event.stepIndex, event]),
  );
  for (const [index, entry] of (edits.zoom ?? []).entries()) {
    const event = events.get(entry.stepIndex);
    if (event?.target === undefined) {
      issues.push({
        path: `zoom[${index}].stepIndex`,
        code: 'zoom-no-target',
        message:
          event === undefined
            ? `step ${entry.stepIndex} is not in the timeline`
            : `step ${entry.stepIndex} (${event.action}) has no target to zoom on`,
      });
    }
  }
  const last = timeline.events.at(-1);
  const endMs =
    (last === undefined ? 0 : last.endMs + (last.holdMs ?? 0)) + tailMs;
  for (const [index, caption] of (edits.captions ?? []).entries()) {
    if (caption.endMs > endMs) {
      issues.push({
        path: `captions[${index}].endMs`,
        code: 'caption-out-of-range',
        message: `expected the caption to end by ${endMs} ms, the end of the video`,
      });
    }
  }
  return issues;
}
