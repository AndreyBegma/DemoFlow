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
] as const;
export const StepActionSchema = z.enum(STEP_ACTIONS);
export type StepAction = z.infer<typeof StepActionSchema>;

export const MarkerKindSchema = z.enum(['scene', 'caption']);
export type MarkerKind = z.infer<typeof MarkerKindSchema>;

/** Fields every step may carry. */
const common = {
  caption: z.string().max(120).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
};

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
  return (
    value: { zoom?: Zoom; target?: unknown; state?: string },
    ctx: z.RefinementCtx,
  ): void => {
    const targeted = value.target !== undefined && value.state !== 'hidden';
    if (value.zoom !== undefined && !targeted) {
      ctx.addIssue({ code: 'custom', message: reason, path: ['zoom'] });
    }
  };
}

function step<A extends StepAction, S extends z.ZodRawShape>(
  action: A,
  shape: S,
) {
  return z.strictObject({ action: z.literal(action), ...shape, ...common });
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

const navigateKeys = ['path', 'url'] as const;
const fillKeys = ['value', 'valueFrom'] as const;
const scrollKeys = ['to', 'target'] as const;

export const StepSchema = z.discriminatedUnion(
  'action',
  [
    step('navigate', {
      // `//host` and `/\host` are protocol-relative: they leave the origin.
      path: z
        .string()
        .regex(/^\/(?![/\\])/, 'expected a path starting with a single /')
        .optional(),
      url: HttpUrlSchema.optional(),
    })
      .superRefine(exactlyOne(navigateKeys))
      .meta(exactlyOneJsonSchema(navigateKeys)),
    step('waitFor', {
      target: LocatorSchema,
      state: z.enum(['visible', 'hidden']).default('visible'),
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
      // Secrets never appear in a scenario (ADR-0003 §5).
      valueFrom: z
        .strictObject({
          env: z
            .string()
            .regex(
              /^[A-Z_][A-Z0-9_]*$/,
              'expected an environment variable name (A-Z, 0-9, _)',
            ),
        })
        .optional(),
    })
      .superRefine(exactlyOne(fillKeys))
      .meta(exactlyOneJsonSchema(fillKeys)),
    step('select', { target: LocatorSchema, option: z.string(), ...zoom }),
    step('hover', { target: LocatorSchema, ...zoom }),
    // No target: the key goes to the focused element.
    step('press', {
      key: PressKeySchema,
      target: LocatorSchema.optional(),
      ...zoom,
    })
      .superRefine(
        zoomNeedsTarget('expected zoom only on a press with a target'),
      )
      .meta({ dependentRequired: { zoom: ['target'] } }),
    step('scroll', {
      to: z.enum(['top', 'bottom']).optional(),
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
      match: z.enum(['exact', 'contains']).default('contains'),
    }),
    step('screenshot', {
      name: z
        .string()
        .regex(/^[a-z0-9-]+$/, 'expected lowercase letters, digits and -'),
    }),
    step('marker', {
      title: NonEmptyStringSchema,
      kind: MarkerKindSchema.default('scene'),
    }),
    step('wait', { ms: z.number().int().min(1).max(5_000) }),
  ],
  { error: `expected action to be one of ${STEP_ACTIONS.join('|')}` },
);
export type Step = z.infer<typeof StepSchema>;
export type StepInput = z.input<typeof StepSchema>;
