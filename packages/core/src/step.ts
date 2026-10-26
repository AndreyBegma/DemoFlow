import { z } from 'zod';
import {
  exactlyOne,
  exactlyOneJsonSchema,
  HttpUrlSchema,
  NonEmptyStringSchema,
} from './common.ts';
import { LocatorSchema } from './locator.ts';

export const STEP_ACTIONS = [
  'navigate',
  'waitFor',
  'click',
  'fill',
  'select',
  'hover',
  'press',
  'scroll',
  'assertVisible',
  'assertText',
  'screenshot',
  'marker',
  'wait',
  'waitForReady',
] as const;
export const StepActionSchema = z.enum(STEP_ACTIONS);
export type StepAction = z.infer<typeof StepActionSchema>;

export const MarkerKindSchema = z.enum(['scene', 'caption']);
export type MarkerKind = z.infer<typeof MarkerKindSchema>;

/**
 * Whether a step is on camera (ADR-0018). `false` runs it before the
 * recording starts, so only the opening steps of a scenario may set it.
 */
export const RecordSchema = z.boolean().optional().meta({
  description:
    'false runs the step off camera: before the recording starts, in the same browser storage (cookies, localStorage). Only the opening steps of a scenario may be off camera; the video starts on the first recorded step.',
});

/** Fields every step may carry. */
const common = {
  caption: z.string().max(120).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  record: RecordSchema,
  hold: z.number().int().min(100).max(10_000).optional().meta({
    description:
      'Milliseconds to keep the page on screen after the step, recorded and never trimmed as idle. Use it, not wait, to show a result. Not on an off-camera step.',
  }),
};

/** Reports a `hold` on an off-camera step: nothing would show it (spec 365). */
function holdNeedsCamera(value: object, ctx: z.RefinementCtx): void {
  if (
    Reflect.get(value, 'hold') !== undefined &&
    Reflect.get(value, 'record') === false
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'expected no hold on an off-camera step (record: false)',
      path: ['hold'],
    });
  }
}

/**
 * Camera zoom on the step's target (ADR-0012): `true` for the renderer's
 * default strength, a number for that strength (`1` is no zoom). Only on steps
 * whose timeline event carries the target's box.
 */
export const ZoomSchema = z.union([z.boolean(), z.number().min(1).max(3)]);
export type Zoom = z.infer<typeof ZoomSchema>;

const zoom = { zoom: ZoomSchema.optional() };

/** Reports a `zoom` the step has no target box for. */
function zoomNeedsTarget(reason: string) {
  return (value: object, ctx: z.RefinementCtx): void => {
    const targeted =
      Reflect.get(value, 'target') !== undefined &&
      Reflect.get(value, 'state') !== 'hidden';
    if (Reflect.get(value, 'zoom') !== undefined && !targeted) {
      ctx.addIssue({ code: 'custom', message: reason, path: ['zoom'] });
    }
  };
}

function step<A extends StepAction, S extends z.ZodRawShape>(
  action: A,
  shape: S,
) {
  return (
    z
      .strictObject({ action: z.literal(action), ...shape, ...common })
      .superRefine(holdNeedsCamera)
      // Not both `hold` and `record: false`.
      .meta({
        dependentSchemas: {
          hold: { properties: { record: { not: { const: false } } } },
        },
      })
  );
}

/** Key names a `press` may send, as Playwright spells them. Typing text is `fill`. */
export const PRESS_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
] as const;
export const PRESS_MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'] as const;

const PRESS_KEY_NAMES: ReadonlySet<string> = new Set(PRESS_KEYS);
const PRESS_MODIFIER_NAMES: ReadonlySet<string> = new Set(PRESS_MODIFIERS);

/** Why `key` is not a valid `press` key, or `undefined` when it is. */
export function pressKeyProblem(key: string): string | undefined {
  const parts = key.split('+');
  const main = parts.pop() ?? '';
  const modifiers = parts;
  if (modifiers.some((part) => !PRESS_MODIFIER_NAMES.has(part))) {
    return `expected modifiers from ${PRESS_MODIFIERS.join('|')}`;
  }
  if (new Set(modifiers).size !== modifiers.length) {
    return 'expected each modifier at most once';
  }
  if (PRESS_KEY_NAMES.has(main)) return undefined;
  // A bare letter or digit would be typing; with a modifier it is a shortcut.
  if (/^[A-Za-z0-9]$/.test(main) && modifiers.length > 0) return undefined;
  return modifiers.length > 0 || main === ''
    ? `expected the key after + to be a letter, a digit or one of ${PRESS_KEYS.join('|')}`
    : `expected one of ${PRESS_KEYS.join('|')}, or a chord such as Control+a`;
}

const PressKeySchema = z.string().superRefine((key, ctx) => {
  const problem = pressKeyProblem(key);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

/** The format of a ready name; the engine's page script checks the same one. */
export const READY_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A name the application passes to `window.demoflow.ready` (ADR-0013 §4). */
export const ReadyNameSchema = z
  .string()
  .regex(
    READY_NAME,
    'expected 1–64 characters: letters, digits and . _ : -, starting with a letter or digit',
  );

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// Secrets never appear in a scenario (ADR-0003 §5), so they never come from data either.
const EnvNameSchema = z
  .string()
  .superRefine((name, ctx) => {
    if (name.includes('{{')) {
      ctx.addIssue({
        code: 'custom',
        message:
          'expected no {{…}} in valueFrom: secrets come from the environment, never from data',
      });
    } else if (!ENV_NAME.test(name)) {
      ctx.addIssue({
        code: 'custom',
        message: 'expected an environment variable name (A-Z, 0-9, _)',
      });
    }
  })
  .meta({ pattern: ENV_NAME.source });

/**
 * A string that still holds a `{{…}}` placeholder: a field of a step inside a
 * `repeat` before substitution. Its format is checked once substituted.
 */
export const TemplateStringSchema = z
  .string()
  .regex(/\{\{/, 'expected a {{…}} placeholder');

interface PlainSteps {
  template: false;
}
interface TemplateSteps {
  template: true;
}
/** A field with a format; inside a `repeat` it may also be a template. */
type Formatted<M, S extends z.ZodType> = M extends TemplateSteps
  ? z.ZodUnion<[S, typeof TemplateStringSchema]>
  : S;

const navigateKeys = ['path', 'url'] as const;
const fillKeys = ['value', 'valueFrom'] as const;
const scrollKeys = ['to', 'target'] as const;

/**
 * The step union. The template variant is what a `repeat` holds: every field
 * with a format (a URL, a path, a key, a name, an enum) also takes a string
 * with a `{{…}}` placeholder; the expanded step is checked against the plain one.
 */
function stepSchema<M extends PlainSteps | TemplateSteps>(mode: M) {
  const format = <S extends z.ZodType>(schema: S): Formatted<M, S> =>
    (mode.template
      ? z.union([schema, TemplateStringSchema], {
          // Neither: the format's own message says what was expected.
          error: (issue) =>
            issue.code === 'invalid_union'
              ? issue.errors[0]?.[0]?.message
              : undefined,
        })
      : schema) as Formatted<M, S>;
  return z.discriminatedUnion(
    'action',
    [
      step('navigate', {
        // `//host` and `/\host` are protocol-relative: they leave the origin.
        path: format(
          z
            .string()
            .regex(/^\/(?![/\\])/, 'expected a path starting with a single /')
            .optional(),
        ),
        url: format(HttpUrlSchema.optional()),
      })
        .superRefine(exactlyOne(navigateKeys))
        .meta(exactlyOneJsonSchema(navigateKeys)),
      step('waitFor', {
        target: LocatorSchema,
        state: format(z.enum(['visible', 'hidden']).default('visible')),
        ...zoom,
      })
        .superRefine(
          zoomNeedsTarget('expected no zoom on a waitFor for a hidden target'),
        )
        // Not both `state: hidden` and `zoom`.
        .meta({
          not: {
            required: ['state', 'zoom'],
            properties: { state: { const: 'hidden' } },
          },
        }),
      step('click', { target: LocatorSchema, ...zoom }),
      step('fill', {
        target: LocatorSchema,
        ...zoom,
        value: z.string().optional(),
        valueFrom: z.strictObject({ env: EnvNameSchema }).optional(),
      })
        .superRefine(exactlyOne(fillKeys))
        .meta(exactlyOneJsonSchema(fillKeys)),
      step('select', { target: LocatorSchema, option: z.string(), ...zoom }),
      step('hover', { target: LocatorSchema, ...zoom }),
      // No target: the key goes to the focused element.
      step('press', {
        key: format(PressKeySchema),
        target: LocatorSchema.optional(),
        ...zoom,
      })
        .superRefine(
          zoomNeedsTarget('expected zoom only on a press with a target'),
        )
        .meta({ dependentRequired: { zoom: ['target'] } }),
      step('scroll', {
        to: format(z.enum(['top', 'bottom']).optional()),
        target: LocatorSchema.optional(),
        // Scroll inside this container instead of the page.
        within: LocatorSchema.optional(),
      })
        .superRefine(exactlyOne(scrollKeys))
        .meta(exactlyOneJsonSchema(scrollKeys)),
      step('assertVisible', { target: LocatorSchema, ...zoom }),
      step('assertText', {
        target: LocatorSchema,
        ...zoom,
        text: NonEmptyStringSchema,
        match: format(z.enum(['exact', 'contains']).default('contains')),
      }),
      step('screenshot', {
        name: format(
          z
            .string()
            .regex(/^[a-z0-9-]+$/, 'expected lowercase letters, digits and -'),
        ),
      }),
      step('marker', {
        title: NonEmptyStringSchema,
        kind: format(MarkerKindSchema.default('scene')),
      }),
      step('wait', { ms: z.number().int().min(1).max(5_000) }),
      // No target and no zoom: the page reports the state, not a locator.
      step('waitForReady', { name: format(ReadyNameSchema) }),
    ],
    {
      error: (issue) =>
        mode.template && actionOf(issue.input) === 'repeat'
          ? 'expected no repeat inside a repeat: loops are one level deep'
          : `expected action to be one of ${STEP_ACTIONS.join('|')}`,
    },
  );
}

function actionOf(input: unknown): unknown {
  return typeof input === 'object' && input !== null && 'action' in input
    ? input.action
    : undefined;
}

/** A plain step: what the engine runs, and what a `repeat` expands to. */
export const StepSchema = stepSchema<PlainSteps>({ template: false });
export type Step = z.infer<typeof StepSchema>;
export type StepInput = z.input<typeof StepSchema>;

/** A step inside a `repeat`, before its `{{…}}` placeholders are substituted. */
export const TemplateStepSchema = stepSchema<TemplateSteps>({
  template: true,
});
export type TemplateStep = z.infer<typeof TemplateStepSchema>;
export type TemplateStepInput = z.input<typeof TemplateStepSchema>;

/** A data list name, a field of its items, or the name a `repeat` gives an item. */
export const DATA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dataKeyMessage =
  'expected letters, digits and _, not starting with a digit';
export const DataKeySchema = z.string().regex(DATA_KEY, dataKeyMessage);

/**
 * Runs its steps once per item of a data list, substituting `{{<as>.<field>}}`
 * and `{{index}}` (1-based) into them. One level: no `repeat` inside.
 */
export const RepeatStepSchema = z.strictObject({
  action: z.literal('repeat'),
  each: DataKeySchema,
  // `index` is taken by `{{index}}`.
  as: z
    .string()
    .regex(
      /^(?!index$)[A-Za-z_][A-Za-z0-9_]*$/,
      `${dataKeyMessage}, other than index`,
    )
    .default('item'),
  steps: z
    .array(TemplateStepSchema)
    .min(1, 'expected at least one step')
    .max(50, 'expected at most 50 steps'),
  // Shown once, before the first iteration.
  caption: z.string().max(120).optional(),
  // For every iteration at once: a step inside a repeat takes none.
  record: RecordSchema,
});
export type RepeatStep = z.infer<typeof RepeatStepSchema>;
export type RepeatStepInput = z.input<typeof RepeatStepSchema>;

/**
 * A fragment's name: its file below the fragments directory, without `.json`
 * (ADR-0018). Folders are separated by `/`; no `..`, so it stays inside.
 */
export const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
export const FragmentNameSchema = z
  .string()
  .regex(
    FRAGMENT_NAME,
    'expected lowercase letters, digits and -, with / between folders',
  );

/** A value an `include` passes to a fragment parameter. */
export const ParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Runs the steps of a fragment file in its place (ADR-0018), with `with`
 * substituted for its `{{params.<name>}}`. Not inside a `repeat`.
 */
export const IncludeStepSchema = z
  .strictObject({
    action: z.literal('include'),
    fragment: FragmentNameSchema.meta({
      description:
        'The fragment file below fragmentsDir (demoflow.config.json; default demoflow/fragments), without .json: "sign-in" reads demoflow/fragments/sign-in.json.',
    }),
    with: z.record(DataKeySchema, ParamValueSchema).optional().meta({
      description:
        'Values for the fragment parameters, by name; a parameter without a default must be given.',
    }),
    record: RecordSchema.meta({
      description:
        'false runs every step of the fragment off camera, for setup such as signing in. Only the opening steps of a scenario may be off camera.',
    }),
  })
  .meta({
    description:
      'Runs the steps of a reusable fragment file here, with its parameters filled in from `with`.',
  });
export type IncludeStep = z.infer<typeof IncludeStepSchema>;
export type IncludeStepInput = z.input<typeof IncludeStepSchema>;

/** A step as a scenario holds it: a plain step, a `repeat` or an `include`. */
export const ScenarioStepSchema = z.discriminatedUnion(
  'action',
  [...StepSchema.options, RepeatStepSchema, IncludeStepSchema],
  {
    error: `expected action to be one of ${STEP_ACTIONS.join('|')}|repeat|include`,
  },
);
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;
export type ScenarioStepInput = z.input<typeof ScenarioStepSchema>;

/** A step of a scenario's `setup`: no `repeat`, and nothing there is recorded. */
export const SetupStepSchema = z.discriminatedUnion(
  'action',
  [...StepSchema.options, IncludeStepSchema],
  {
    error: (issue) =>
      actionOf(issue.input) === 'repeat'
        ? 'expected no repeat in setup'
        : `expected action to be one of ${STEP_ACTIONS.join('|')}|include`,
  },
);
export type SetupStep = z.infer<typeof SetupStepSchema>;

/**
 * A step of a fragment file: a plain step whose strings may hold
 * `{{params.<name>}}`, or an `include` of another fragment. No `repeat`.
 */
export const FragmentStepSchema = z.discriminatedUnion(
  'action',
  [...TemplateStepSchema.options, IncludeStepSchema],
  {
    error: (issue) =>
      actionOf(issue.input) === 'repeat'
        ? 'expected no repeat in a fragment'
        : `expected action to be one of ${STEP_ACTIONS.join('|')}|include`,
  },
);
export type FragmentStep = z.infer<typeof FragmentStepSchema>;
