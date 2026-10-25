import { z } from 'zod';
import { NonEmptyStringSchema } from './common.ts';
import { formatPath, type Issue } from './issues.ts';

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

/** A warning on each `{ css }` locator of a step, at `path` (its `target` or `within`). */
export function cssLocatorWarnings(
  step: object,
  path: readonly PropertyKey[],
): Issue[] {
  const warnings: Issue[] = [];
  for (const key of ['target', 'within']) {
    const locator: unknown = Reflect.get(step, key);
    if (typeof locator === 'object' && locator !== null && 'css' in locator) {
      warnings.push({
        path: formatPath([...path, key]),
        code: 'css-locator',
        message:
          'a CSS selector breaks when the markup changes; prefer role, label, testId, text or placeholder',
      });
    }
  }
  return warnings;
}
