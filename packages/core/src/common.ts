import { z } from 'zod';

export const NonEmptyStringSchema = z.string().min(1);

/** An absolute `http:` or `https:` URL. Any other scheme (`file:`, `javascript:`, …) is rejected. */
export const HttpUrlSchema = z
  .url({
    protocol: /^https?$/,
    error: 'expected an absolute http or https URL',
  })
  .meta({ pattern: '^[hH][tT][tT][pP][sS]?://' });

export const ViewportSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

/**
 * Accepts the `$schema` key editors use to associate a JSON file with its
 * JSON Schema, so a scenario or config that points at its schema still parses.
 */
export const JsonSchemaRefSchema = z.string().optional();

/**
 * A `superRefine` callback that requires exactly one of `keys` to be present.
 * Pair it with `exactlyOneJsonSchema(keys)` so editors enforce the same rule.
 */
export function exactlyOne<K extends string>(keys: readonly K[]) {
  return (value: object, ctx: z.RefinementCtx): void => {
    const present = keys.filter((key) => Reflect.get(value, key) !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `expected exactly one of ${keys.join('|')}`,
      });
    }
  };
}

export function exactlyOneJsonSchema(keys: readonly string[]) {
  return { oneOf: keys.map((key) => ({ required: [key] })) };
}
