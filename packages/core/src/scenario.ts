import { z } from 'zod';
import {
  HttpUrlSchema,
  JsonSchemaRefSchema,
  NonEmptyStringSchema,
  ViewportSchema,
} from './common.ts';
import { DataKeySchema, ScenarioStepSchema } from './step.ts';

/** One item of a data list: the fields a `repeat` substitutes. */
export const DataItemSchema = z.record(
  DataKeySchema,
  z.union([z.string(), z.number(), z.boolean()]),
);
export type DataItem = z.infer<typeof DataItemSchema>;

/** Lists a `repeat` runs over, by name (spec 165). */
export const ScenarioDataSchema = z.record(
  DataKeySchema,
  z
    .array(DataItemSchema)
    .min(1, 'expected at least one item')
    .max(100, 'expected at most 100 items'),
);
export type ScenarioData = z.infer<typeof ScenarioDataSchema>;

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
    data: ScenarioDataSchema.optional(),
    steps: z
      .array(ScenarioStepSchema)
      .min(1, 'expected at least one step')
      .max(200, 'expected at most 200 steps'),
  })
  .meta({
    title: 'DemoFlow scenario',
    description: 'A scenario DemoFlow runs, records and renders.',
  });
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
