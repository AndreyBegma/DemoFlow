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

/** The built-in backgrounds (spec 100, Decision 2); the renderer holds their colours. */
export const BACKGROUND_PRESETS = [
  'ocean',
  'sunset',
  'forest',
  'dusk',
  'graphite',
  'paper',
] as const;
export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];

const ColourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour such as #1e3a5f');

/** A built-in preset, a solid colour, or a two-stop gradient — never an image (spec 100). */
export const BackgroundConfigSchema = z.union([
  z.strictObject({ preset: z.enum(BACKGROUND_PRESETS) }),
  z.strictObject({ color: ColourSchema }),
  z.strictObject({
    gradient: z.strictObject({
      from: ColourSchema,
      to: ColourSchema,
      angle: z.number().min(0).max(360).meta({
        description:
          'Degrees, as in CSS linear-gradient: 0 runs towards the top, clockwise (90 towards the right).',
      }),
    }),
  }),
]);
export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

/**
 * The page in a rounded, shadowed window on the background (spec 100).
 * `enabled: false` renders the page full-bleed, as before.
 */
export const FrameConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    /** The margin on every side, as a share of the output height. */
    marginRatio: z.number().min(0).lt(0.25).default(0.06),
    /** Corner radius in output pixels at 1080p, scaled with the output height. */
    radius: z.number().nonnegative().default(12),
    shadow: z.boolean().default(true),
  })
  .prefault({});
export type FrameConfig = z.infer<typeof FrameConfigSchema>;

const CardDurationSchema = z.number().int().min(500).max(10_000);

const CardTextSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/\S/, 'expected some text, not only spaces');

/**
 * Cards inserted between page frames (spec 108): an intro from the scenario's
 * name and description, one per `scene` marker, and an outro. The outro is off
 * unless it has a `title` — the config has no project name to fall back on.
 */
export const CardsConfigSchema = z
  .strictObject({
    intro: z
      .strictObject({
        enabled: z.boolean().default(true),
        durationMs: CardDurationSchema.default(2000),
      })
      .prefault({}),
    scenes: z
      .strictObject({
        enabled: z.boolean().default(true),
        durationMs: CardDurationSchema.default(1500),
      })
      .prefault({}),
    outro: z
      .strictObject({
        title: CardTextSchema.optional(),
        /** A second line under the title, e.g. a URL. */
        cta: CardTextSchema.optional(),
        durationMs: CardDurationSchema.default(2500),
      })
      .prefault({}),
  })
  .prefault({});
export type CardsConfig = z.infer<typeof CardsConfigSchema>;

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
    frame: FrameConfigSchema,
    background: BackgroundConfigSchema.default({ preset: 'ocean' }),
    cards: CardsConfigSchema,
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
