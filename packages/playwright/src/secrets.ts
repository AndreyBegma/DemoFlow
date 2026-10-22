// Secrets never reach a scenario in clear (ADR-0015 §4, spec 208 Decision 5).

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Shorter values match too much by accident: `1`, `true`, a username. */
export const SECRET_MIN_LENGTH = 8;

/**
 * The environment variable whose current value is `value`, the first in
 * sorted order when several match; `undefined` for short values.
 */
export function envNameOf(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (value.length < SECRET_MIN_LENGTH) return undefined;
  return Object.keys(env)
    .filter((name) => ENV_NAME.test(name) && env[name] === value)
    .sort()[0];
}
