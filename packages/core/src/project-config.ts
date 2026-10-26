import { z } from 'zod';
import {
  HttpUrlSchema,
  JsonSchemaRefSchema,
  NonEmptyStringSchema,
} from './common.ts';
import { RENDER_FORMATS } from './run-result.ts';

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

/**
 * Dissolves between a card and the page, and from the held frame of a page
 * load into the loaded page (spec 114). Dissolve only, no other styles.
 */
export const TransitionsConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    /**
     * At most half the shortest card that is on: a card fades in and out
     * within its own time. Default 300, or half the shortest card when that
     * is less, so a 500 ms card valid before #114 stays valid.
     */
    durationMs: z.number().int().min(100).max(1000).optional().meta({
      description:
        'Milliseconds; at most half the shortest card that is on. Default 300, or half the shortest card when that is less.',
    }),
  })
  .prefault({});

/** The transitions of a parsed config: the duration is always resolved. */
export interface TransitionsConfig {
  enabled: boolean;
  durationMs: number;
}

const DEFAULT_TRANSITION_MS = 300;

/**
 * The GIF's own size and rate (spec 133); its height follows the render's
 * aspect ratio. Used only when `formats` has `gif`.
 */
export const GifConfigSchema = z
  .strictObject({
    width: z.number().int().min(160).optional().meta({
      description:
        'Pixels, at most render.width. Default 800, or render.width when that is less.',
    }),
    fps: z.number().int().positive().optional().meta({
      description:
        'At most render.fps. Default 12, or render.fps when that is less.',
    }),
  })
  .prefault({});

/** The GIF of a parsed config: both values are always resolved. */
export interface GifConfig {
  width: number;
  fps: number;
}

const DEFAULT_GIF = { width: 800, fps: 12 } as const;

/**
 * The 9:16 output (spec 176): a crop of the page that follows each step's
 * target, with captions in a band at the bottom. Used only when `formats`
 * has a `*-vertical` format.
 */
export const VerticalConfigSchema = z
  .strictObject({
    followMs: z.number().int().min(0).max(2000).default(400).meta({
      description:
        'Milliseconds the crop takes to move to the next target, eased in and out.',
    }),
    deadZone: z.number().min(0).lt(0.5).default(0.1).meta({
      description:
        'A move shorter than this share of the crop width is skipped, so the camera does not jitter.',
    }),
    captionBand: z.number().gt(0).max(0.5).default(0.22).meta({
      description:
        'The share of the frame height, at the bottom, that captions sit in.',
    }),
  })
  .prefault({});
export type VerticalConfig = z.infer<typeof VerticalConfigSchema>;

/**
 * The 1:1 output (spec 304): the same fields, ranges and defaults as
 * `render.vertical`, tuned on its own. Used only when `formats` has a
 * `*-square` format.
 */
export const SquareConfigSchema = VerticalConfigSchema;
export type SquareConfig = VerticalConfig;

/** The durations of the cards that are on (spec 108): an outro only with a title. */
function cardsOn(cards: CardsConfig): number[] {
  return [
    cards.intro.enabled ? cards.intro.durationMs : undefined,
    cards.scenes.enabled ? cards.scenes.durationMs : undefined,
    cards.outro.title === undefined ? undefined : cards.outro.durationMs,
  ].filter((ms) => ms !== undefined);
}

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
    // Kept on screen after the last step of a successful run (spec 365).
    endHoldMs: z.number().int().min(0).max(10_000).default(3500).meta({
      description:
        'How long a successful video keeps the result on screen after the last step: the engine keeps recording and the renderer keeps the frames. 0 ends the video at the last step.',
    }),
    frame: FrameConfigSchema,
    background: BackgroundConfigSchema.default({ preset: 'ocean' }),
    cards: CardsConfigSchema,
    transitions: TransitionsConfigSchema,
    /** Every file a run writes, in this order (spec 133). */
    formats: z
      .array(z.enum(RENDER_FORMATS))
      .min(1)
      .refine(
        (formats) => new Set(formats).size === formats.length,
        'expected each format once',
      )
      .default(() => ['mp4' as const]),
    gif: GifConfigSchema,
    vertical: VerticalConfigSchema,
    square: SquareConfigSchema,
  })
  .superRefine(({ width, fps, cards, transitions, gif }, ctx) => {
    if (gif.width !== undefined && gif.width > width) {
      ctx.addIssue({
        code: 'custom',
        message: `expected at most render.width (${width})`,
        path: ['gif', 'width'],
      });
    }
    if (gif.fps !== undefined && gif.fps > fps) {
      ctx.addIssue({
        code: 'custom',
        message: `expected at most render.fps (${fps})`,
        path: ['gif', 'fps'],
      });
    }
    const { enabled, durationMs } = transitions;
    if (!enabled || durationMs === undefined) return;
    const shortest = Math.min(...cardsOn(cards));
    if (durationMs > shortest / 2) {
      ctx.addIssue({
        code: 'custom',
        message: `expected at most half the shortest card (${shortest} ms)`,
        path: ['transitions', 'durationMs'],
      });
    }
  })
  .transform(({ transitions, gif, ...render }) => {
    const resolvedGif: GifConfig = {
      width: gif.width ?? Math.min(DEFAULT_GIF.width, render.width),
      fps: gif.fps ?? Math.min(DEFAULT_GIF.fps, render.fps),
    };
    const resolved: TransitionsConfig = {
      enabled: transitions.enabled,
      durationMs:
        transitions.durationMs ??
        Math.min(
          DEFAULT_TRANSITION_MS,
          Math.floor(Math.min(...cardsOn(render.cards)) / 2),
        ),
    };
    return { ...render, transitions: resolved, gif: resolvedGif };
  })
  .prefault({});
export type RenderConfig = z.infer<typeof RenderConfigSchema>;

const PORT_TEMPLATE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax.
  '${PORT} is the port of the run: --port, else PORT from the environment, else the default in ${PORT:-3000}. $${ is a literal ${.';
const DEV_TEMPLATE = `${PORT_TEMPLATE} \${BASE_URL} is --base-url, else baseUrl after substitution.`;

/** `demoflow.config.json` at the project root — data, never code (ADR-0003 §6). */
export const ProjectConfigSchema = z
  .strictObject({
    $schema: JsonSchemaRefSchema,
    baseUrl: HttpUrlSchema.meta({
      description: `Where the app runs. ${PORT_TEMPLATE}`,
    }),
    // The origin of `baseUrl` is always one of them.
    allowedOrigins: z.array(OriginSchema).optional(),
    devCommand: z
      .strictObject({
        command: NonEmptyStringSchema.meta({
          description: `The program that starts the app, run without a shell. ${DEV_TEMPLATE}`,
        }),
        args: z
          .array(z.string())
          .optional()
          .meta({
            description: `Its arguments, one string each. ${DEV_TEMPLATE}`,
          }),
        readyUrl: HttpUrlSchema.meta({
          description: `The app is up once this URL answers. ${DEV_TEMPLATE}`,
        }),
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    artifactsDir: NonEmptyStringSchema.optional(),
    fragmentsDir: NonEmptyStringSchema.optional().meta({
      description:
        'Where the fragments scenarios include live, relative to the project root. Default demoflow/fragments.',
    }),
    render: RenderConfigSchema,
  })
  .transform(({ allowedOrigins, ...config }) => {
    const origin = new URL(config.baseUrl).origin;
    return {
      ...config,
      allowedOrigins:
        allowedOrigins === undefined
          ? [origin]
          : allowedOrigins.includes(origin)
            ? allowedOrigins
            : [...allowedOrigins, origin],
    };
  })
  .meta({
    title: 'DemoFlow project config',
    description: 'demoflow.config.json at the project root.',
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
