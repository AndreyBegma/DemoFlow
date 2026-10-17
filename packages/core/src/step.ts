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

function step<A extends StepAction, S extends z.ZodRawShape>(
  action: A,
  shape: S,
) {
  return z.strictObject({ action: z.literal(action), ...shape, ...common });
}

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
    }),
    step('click', { target: LocatorSchema }),
    step('fill', {
      target: LocatorSchema,
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
    step('select', { target: LocatorSchema, option: z.string() }),
    step('hover', { target: LocatorSchema }),
    step('scroll', {
      to: z.enum(['top', 'bottom']).optional(),
      target: LocatorSchema.optional(),
      // Scroll inside this container instead of the page.
      within: LocatorSchema.optional(),
    })
      .superRefine(exactlyOne(scrollKeys))
      .meta(exactlyOneJsonSchema(scrollKeys)),
    step('assertVisible', { target: LocatorSchema }),
    step('assertText', {
      target: LocatorSchema,
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
