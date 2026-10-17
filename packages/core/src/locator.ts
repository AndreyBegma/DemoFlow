import { z } from 'zod';
import { NonEmptyStringSchema } from './common.ts';

/** The keys that select a locator shape; a locator carries exactly one. */
export const LOCATOR_KEYS = [
  'role',
  'label',
  'testId',
  'text',
  'placeholder',
  'css',
] as const;

const exact = z.boolean().optional();

/**
 * A structured locator, mapped one-to-one onto Playwright (ADR-0003 §3).
 * Coordinates are never a locator; `{ css }` is accepted with a warning.
 */
export const LocatorSchema = z.union(
  [
    // getByRole — `role` is an ARIA role.
    z.strictObject({
      role: NonEmptyStringSchema,
      name: z.string().optional(),
      exact,
    }),
    z.strictObject({ label: NonEmptyStringSchema, exact }),
    z.strictObject({ testId: NonEmptyStringSchema }),
    z.strictObject({ text: NonEmptyStringSchema, exact }),
    z.strictObject({ placeholder: NonEmptyStringSchema, exact }),
    z.strictObject({ css: NonEmptyStringSchema }),
  ],
  { error: `expected exactly one of ${LOCATOR_KEYS.join('|')}` },
);
export type Locator = z.infer<typeof LocatorSchema>;

export function isCssLocator(locator: Locator): locator is { css: string } {
  return 'css' in locator;
}
