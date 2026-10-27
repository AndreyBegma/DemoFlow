import { z } from 'zod';
import {
  HttpUrlSchema,
  JsonSchemaRefSchema,
  NonEmptyStringSchema,
  ViewportSchema,
} from './common.ts';
import {
  DataKeySchema,
  DwellMsSchema,
  ScenarioStepSchema,
  SetupStepSchema,
  TypingDelayMsSchema,
} from './step.ts';

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

/** What the browser records as: a desktop (the default) or a phone (spec 305). */
export const DEVICES = ['desktop', 'phone'] as const;
export const DeviceSchema = z.enum(DEVICES);
export type Device = z.infer<typeof DeviceSchema>;

/** The viewport a scenario gets when it sets none, by device. */
export const DEFAULT_VIEWPORTS: Record<
  Device,
  { width: number; height: number }
> = {
  desktop: { width: 1920, height: 1080 },
  // 914, not the Pixel 7's 915: Playwright floors the video to even dimensions.
  phone: { width: 412, height: 914 },
};

/** How fast the recorded steps play when a scenario sets no `pacing` (C-203). */
export const DEFAULT_PACING = {
  stepDwellMs: 1_000,
  typingDelayMs: 80,
} as const;

/**
 * How fast a recording plays (C-203): a pause after each visible step and the
 * typing speed (the final frame is held by `render.endHoldMs`). Setup and off-camera steps are not
 * paced.
 */
export const PacingSchema = z
  .strictObject({
    stepDwellMs: DwellMsSchema.default(DEFAULT_PACING.stepDwellMs).meta({
      description:
        'Milliseconds the recording stays on the result of each visible step (navigate, click, hover, fill, select, press, scroll, assertVisible, assertText) before the next one. A step overrides it with hold; 0 turns it off.',
    }),
    typingDelayMs: TypingDelayMsSchema.default(
      DEFAULT_PACING.typingDelayMs,
    ).meta({
      description:
        'Milliseconds between two typed characters of a fill. A fill overrides it with typingDelayMs.',
    }),
  })
  .meta({
    description:
      'How fast the recording plays. Every field has a default; setup and off-camera steps are not paced.',
  });
export type Pacing = z.infer<typeof PacingSchema>;

/** The scenario's pacing with every default filled in. */
export function resolvePacing(pacing: Partial<Pacing> | undefined): Pacing {
  return { ...DEFAULT_PACING, ...pacing };
}

/** A scenario file, `demoflow/**\/*.demo.json` (ADR-0003). */
export const ScenarioSchema = z
  .strictObject({
    $schema: JsonSchemaRefSchema,
    schemaVersion: z.literal(1),
    name: NonEmptyStringSchema,
    description: z.string().optional(),
    browser: z.literal('chromium').default('chromium'),
    baseUrl: HttpUrlSchema.optional(),
    device: DeviceSchema.default('desktop').meta({
      description:
        'What the browser records as. "phone" is a touch device with a mobile user agent and a 412x914 viewport unless `viewport` says otherwise.',
    }),
    viewport: ViewportSchema.optional(),
    data: ScenarioDataSchema.optional(),
    pacing: PacingSchema.optional(),
    setup: z
      .array(SetupStepSchema)
      .min(1, 'expected at least one step')
      .max(200, 'expected at most 200 steps')
      .optional()
      .meta({
        description:
          'Steps that run off camera before the recording starts, such as signing in: an include of a fragment, or plain steps. The recording starts in the same browser storage (cookies, localStorage), on the page setup ended on.',
      }),
    steps: z
      .array(ScenarioStepSchema)
      .min(1, 'expected at least one step')
      .max(200, 'expected at most 200 steps'),
  })
  .transform((scenario) => ({
    ...scenario,
    viewport: scenario.viewport ?? DEFAULT_VIEWPORTS[scenario.device],
  }))
  .meta({
    title: 'DemoFlow scenario',
    description: 'A scenario DemoFlow runs, records and renders.',
  });
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
