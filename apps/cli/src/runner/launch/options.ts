import { RENDER_FORMATS, type RenderFormat } from '@demoflow/core';

/**
 * ADR-0017: the run options this daemon accepts on `run.start`, announced in
 * `launches.sync`. A closed list: the website may choose formats and nothing else.
 */
export const RUN_OPTIONS = ['formats'] as const;

export type RunOptionsCheck =
  | { ok: true; formats: RenderFormat[] | null }
  | { ok: false };

/**
 * Spec 326, Decision 3: `undefined` is the project's own formats; anything
 * else is an object whose only key is `formats`, 1 to 9 distinct members of
 * `RENDER_FORMATS`. The result holds the enum's own constants, never the
 * incoming strings.
 */
export function checkRunOptions(value: unknown): RunOptionsCheck {
  if (value === undefined) return { ok: true, formats: null };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'formats') return { ok: false };
  const { formats } = value as { formats?: unknown };
  if (
    !Array.isArray(formats) ||
    formats.length < 1 ||
    formats.length > RENDER_FORMATS.length
  ) {
    return { ok: false };
  }
  const checked: RenderFormat[] = [];
  for (const entry of formats as unknown[]) {
    const known = RENDER_FORMATS.find((format) => format === entry);
    if (known === undefined || checked.includes(known)) return { ok: false };
    checked.push(known);
  }
  return { ok: true, formats: checked };
}
