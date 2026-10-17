import { z } from 'zod';
import { NonEmptyStringSchema } from './common.ts';

export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

/** Every stage reports its own status (ADR-0004 §3). */
export const STAGE_NAMES = [
  'readiness',
  'execution',
  'verification',
  'recording',
  'rendering',
  'storage',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const RunStatusSchema = z.enum([
  'completed',
  'completed_with_warnings',
  'failed',
  'running',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

const TimestampSchema = z.iso.datetime({ offset: true });

export const StageSchema = z.strictObject({
  status: StageStatusSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  error: z
    .strictObject({
      message: z.string(),
      stepIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type Stage = z.infer<typeof StageSchema>;

export const StagesSchema = z.strictObject({
  readiness: StageSchema,
  execution: StageSchema,
  verification: StageSchema,
  recording: StageSchema,
  rendering: StageSchema,
  storage: StageSchema,
});
export type Stages = z.infer<typeof StagesSchema>;

/**
 * The run status, derived from the stages — never from whether a video exists.
 * Any failed stage fails the run, so a rendered video of a failed
 * verification is still `failed` (ADR-0004 §3–4).
 */
export function deriveRunStatus(
  stages: Readonly<Record<StageName, Pick<Stage, 'status'>>>,
  warnings: readonly string[] = [],
): RunStatus {
  const statuses = STAGE_NAMES.map((name) => stages[name].status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.some((status) => status === 'running' || status === 'pending')) {
    return 'running';
  }
  return warnings.length > 0 ? 'completed_with_warnings' : 'completed';
}

export const RenderOutputSchema = z.strictObject({
  renderer: NonEmptyStringSchema,
  // Relative to the run directory.
  file: NonEmptyStringSchema,
  durationMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;

/** `result.json`, the report of one run. */
export const RunResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: NonEmptyStringSchema,
    // The scenario's path relative to the project root (ADR-0003 §2).
    scenarioId: NonEmptyStringSchema,
    scenarioName: NonEmptyStringSchema,
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    status: RunStatusSchema,
    stages: StagesSchema,
    renders: z.array(RenderOutputSchema),
    warnings: z.array(z.string()),
  })
  .refine(
    (result) =>
      result.status === deriveRunStatus(result.stages, result.warnings),
    {
      message: 'expected status to match the status derived from the stages',
      path: ['status'],
    },
  );
export type RunResult = z.infer<typeof RunResultSchema>;
