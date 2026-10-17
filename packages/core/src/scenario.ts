import { z } from 'zod';
import {
  HttpUrlSchema,
  JsonSchemaRefSchema,
  NonEmptyStringSchema,
  ViewportSchema,
} from './common.ts';
import { StepSchema } from './step.ts';

/** A scenario file, `demoflow/**\/*.demo.json` (ADR-0003). */
export const ScenarioSchema = z
  .strictObject({
    $schema: JsonSchemaRefSchema,
    schemaVersion: z.literal(1),
    name: NonEmptyStringSchema,
    description: z.string().optional(),
    browser: z.literal('chromium').default('chromium'),
    baseUrl: HttpUrlSchema.optional(),
    viewport: ViewportSchema.default({ width: 1920, height: 1080 }),
    steps: z
      .array(StepSchema)
      .min(1, 'expected at least one step')
      .max(200, 'expected at most 200 steps'),
  })
  .meta({
    title: 'DemoFlow scenario',
    description: 'A scenario DemoFlow runs, records and renders.',
  });
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
