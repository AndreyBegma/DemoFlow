import { z } from 'zod';
import type { Issue } from './issues.ts';
import {
  BackgroundConfigSchema,
  CardTextSchema,
  FrameConfigSchema,
} from './project-config.ts';
import type { RunResult } from './run-result.ts';
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

const MAX_CUTS = 100;

/** The least page a trim and cuts may leave (spec 354). */
const MIN_PAGE_MS = 500;

/** A new start and a new end of the page, either optional. */
const TrimSchema = z
  .strictObject({ startMs: msSchema.optional(), endMs: msSchema.optional() })
  .refine(
    (trim) =>
      trim.startMs === undefined ||
      trim.endMs === undefined ||
      trim.startMs < trim.endMs,
    { message: 'expected endMs to be after startMs', path: ['endMs'] },
  );

const CutSchema = z
  .strictObject({ startMs: msSchema, endMs: msSchema })
  .refine((cut) => cut.endMs > cut.startMs, {
    message: 'expected endMs to be after startMs',
    path: ['endMs'],
  });

/** Ordered by `startMs`, at least 1 ms apart: two touching cuts are one cut. */
const CutsSchema = z
  .array(CutSchema)
  .max(MAX_CUTS)
  .superRefine((cuts, ctx) => {
    for (const [index, cut] of cuts.entries()) {
      const previous = cuts[index - 1];
      if (previous !== undefined && cut.startMs <= previous.endMs) {
        ctx.addIssue({
          code: 'custom',
          message:
            'expected cuts ordered by startMs, neither overlapping nor touching',
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
  // Timeline ms (spec 354): the page plays from `startMs` to `endMs`, less
  // every cut. The source stays as recorded.
  trim: TrimSchema.optional(),
  cuts: CutsSchema.optional(),
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
 *
 * The trim and the cuts (spec 354) are checked against the run's range — to
 * the failed step's end on a failed run, as the renderer ends it: every cut
 * inside the trimmed range, nothing hiding the failure (ADR-0004 §4,
 * ADR-0020 §2), and at least 500 ms of page left.
 */
export function checkRunEdits(
  edits: RunEdits,
  timeline: Timeline,
  result: RunResult,
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
  issues.push(...checkTrim(edits, timeline, result, endMs));
  return issues;
}

/** `passedEndMs`: where the video of a passed run ends, in timeline ms. */
function checkTrim(
  { trim, cuts = [] }: RunEdits,
  timeline: Timeline,
  result: RunResult,
  passedEndMs: number,
): Issue[] {
  if (trim === undefined && cuts.length === 0) return [];
  const issues: Issue[] = [];
  const failure = failureOf(result);
  const failedEvent =
    failure?.stepIndex === undefined
      ? undefined
      : timeline.events.find((event) => event.stepIndex === failure.stepIndex);
  const lastEvent = timeline.events.at(-1);
  // The renderer's range: to the failure, or the end hold after the last event.
  const runEndMs =
    lastEvent === undefined
      ? Infinity
      : failure === undefined
        ? passedEndMs
        : (failedEvent ?? lastEvent).endMs;
  const fromMs = trim?.startMs ?? 0;
  const toMs = Math.min(trim?.endMs ?? Infinity, runEndMs);
  for (const [index, cut] of cuts.entries()) {
    if (cut.startMs < fromMs || cut.endMs > toMs) {
      issues.push({
        path: `cuts[${index}]`,
        code: 'cut-outside-trim',
        message: `expected the cut inside the page, ${fromMs}–${toMs} ms`,
      });
    }
  }
  if (failedEvent !== undefined) {
    if (trim?.endMs !== undefined && trim.endMs < failedEvent.endMs) {
      issues.push({
        path: 'trim.endMs',
        code: 'trim-hides-failure',
        message: `expected the trim to end at or after ${failedEvent.endMs} ms, where step ${failedEvent.stepIndex} failed`,
      });
    }
    // A step with no length still shows for the instant it starts.
    const failedUntil = Math.max(failedEvent.endMs, failedEvent.startMs + 1);
    for (const [index, cut] of cuts.entries()) {
      if (cut.startMs < failedUntil && cut.endMs > failedEvent.startMs) {
        issues.push({
          path: `cuts[${index}]`,
          code: 'trim-hides-failure',
          message: `expected the cut to leave step ${failedEvent.stepIndex}, which failed, on screen`,
        });
      }
    }
  }
  if (Number.isFinite(toMs)) {
    const cutMs = cuts.reduce(
      (sum, cut) =>
        sum +
        Math.max(0, Math.min(cut.endMs, toMs) - Math.max(cut.startMs, fromMs)),
      0,
    );
    if (toMs - fromMs - cutMs < MIN_PAGE_MS) {
      issues.push({
        path: trim === undefined ? 'cuts' : 'trim',
        code: 'too-short',
        message: `expected at least ${MIN_PAGE_MS} ms of page after the trim and the cuts`,
      });
    }
  }
  return issues;
}

/** The failure of a capture stage, as the renderer reads it; `undefined` on a passed run. */
function failureOf(result: RunResult): { stepIndex?: number } | undefined {
  for (const stage of CAPTURE_STAGES) {
    const state = result.stages[stage];
    if (state.status === 'failed') {
      return state.error?.stepIndex === undefined
        ? {}
        : { stepIndex: state.error.stepIndex };
    }
  }
  return undefined;
}

/** The stages that decide whether the run failed; `rendering` and `storage` do not. */
const CAPTURE_STAGES = [
  'readiness',
  'execution',
  'verification',
  'recording',
] as const;
