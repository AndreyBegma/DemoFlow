import { z } from 'zod';
import {
  HttpUrlSchema,
  JsonSchemaRefSchema,
  NonEmptyStringSchema,
} from './common.ts';

const OriginSchema = HttpUrlSchema.refine(
  (value) => new URL(value).origin === value,
  'expected an origin such as https://example.com, without a path',
);

/** Render defaults per ADR-0004 §5–6: 1920×1080, 30 fps, idle 1 s → 400 ms. */
export const RenderConfigSchema = z
  .strictObject({
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    fps: z.number().int().positive().default(30),
    idle: z
      .strictObject({
        thresholdMs: z.number().int().nonnegative().default(1000),
        compressToMs: z.number().int().nonnegative().default(400),
      })
      .prefault({}),
  })
  .prefault({});
export type RenderConfig = z.infer<typeof RenderConfigSchema>;

/** `demoflow.config.json` at the project root — data, never code (ADR-0003 §6). */
export const ProjectConfigSchema = z
  .strictObject({
    $schema: JsonSchemaRefSchema,
    baseUrl: HttpUrlSchema,
    // Defaults to the origin of `baseUrl`.
    allowedOrigins: z.array(OriginSchema).optional(),
    devCommand: z
      .strictObject({
        command: NonEmptyStringSchema,
        args: z.array(z.string()).optional(),
        readyUrl: HttpUrlSchema,
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    artifactsDir: NonEmptyStringSchema.optional(),
    render: RenderConfigSchema,
  })
  .transform(({ allowedOrigins, ...config }) => ({
    ...config,
    allowedOrigins: allowedOrigins ?? [new URL(config.baseUrl).origin],
  }))
  .meta({
    title: 'DemoFlow project config',
    description: 'demoflow.config.json at the project root.',
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
