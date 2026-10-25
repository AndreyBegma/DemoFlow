import type { z } from 'zod';
import {
  type ConfigVariables,
  resolveConfigTemplates,
} from './config-template.ts';
import { expandSteps } from './expand.ts';
import { type FragmentSource, resolveFragments } from './fragment.ts';
import { type Issue, toIssues } from './issues.ts';
import { cssLocatorWarnings } from './locator.ts';
import { type ProjectConfig, ProjectConfigSchema } from './project-config.ts';
import { type Scenario, ScenarioSchema } from './scenario.ts';

export { formatPath, type Issue } from './issues.ts';

export type ParseResult<T> =
  | { ok: true; value: T; warnings: Issue[] }
  | { ok: false; errors: Issue[] };

function parseWith<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; errors: Issue[] } {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: toIssues(result.error.issues) };
}

export interface ParseScenarioOptions {
  /** Reads the fragments the scenario includes (ADR-0018). */
  fragments?: FragmentSource;
}

/**
 * Validates a scenario and applies its defaults, inlines the fragments it
 * includes, then checks its `{{…}}` substitution: every expanded step must be
 * a valid step (spec 165). The value is the resolved scenario, with no
 * `include` left. Warns on every `{ css }` locator.
 */
export function parseScenario(
  input: unknown,
  options: ParseScenarioOptions = {},
): ParseResult<Scenario> {
  const result = parseWith(ScenarioSchema, input);
  if (!result.ok) return result;
  const authored = result.value;
  // The authored steps keep their own paths in the issues.
  const expansion = expandSteps(authored, { skipIncludes: true });
  const resolution = resolveFragments(authored, options.fragments);
  const errors = [...expansion.issues, ...resolution.issues];
  if (errors.length > 0) return { ok: false, errors };
  // What the fragments brought in expands as well: their own checks hold.
  const resolved = expandSteps(resolution.scenario);
  if (resolved.issues.length > 0) return { ok: false, errors: resolved.issues };

  const warnings: Issue[] = [];
  for (const [key, steps] of [
    ['setup', authored.setup ?? []],
    ['steps', authored.steps],
  ] as const) {
    steps.forEach((step, index) => {
      if (step.action === 'repeat') {
        step.steps.forEach((inner, innerIndex) => {
          warnings.push(
            ...cssLocatorWarnings(inner, [key, index, 'steps', innerIndex]),
          );
        });
      } else if (step.action !== 'include') {
        warnings.push(...cssLocatorWarnings(step, [key, index]));
      }
    });
  }
  warnings.push(...resolution.warnings);
  return { ok: true, value: resolution.scenario, warnings };
}

/**
 * Validates `demoflow.config.json` and applies its defaults, after its
 * `${PORT}` / `${BASE_URL}` templates are filled from `variables` (spec 337).
 * With `variables.baseUrl`, `allowedOrigins` follows that URL's origin.
 */
export function parseProjectConfig(
  input: unknown,
  variables: ConfigVariables = {},
): ParseResult<ProjectConfig> {
  const templated = resolveConfigTemplates(input, variables);
  if (!templated.ok) return templated;
  const result = parseWith(ProjectConfigSchema, templated.value);
  if (!result.ok) return result;
  const value =
    variables.baseUrl === undefined
      ? result.value
      : withEffectiveOrigin(
          result.value,
          variables.baseUrl,
          hasAllowedOrigins(templated.value),
        );
  return { ok: true, value, warnings: [] };
}

function hasAllowedOrigins(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    Reflect.get(input, 'allowedOrigins') !== undefined
  );
}

/**
 * `allowedOrigins` for a run on `baseUrl` instead of the config's: its origin
 * alone when the config lists none, else added once. A URL that does not
 * parse is left for the run's readiness stage to report.
 */
function withEffectiveOrigin(
  config: ProjectConfig,
  baseUrl: string,
  listed: boolean,
): ProjectConfig {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return config;
    origin = url.origin;
  } catch {
    return config;
  }
  if (!listed) return { ...config, allowedOrigins: [origin] };
  return config.allowedOrigins.includes(origin)
    ? config
    : { ...config, allowedOrigins: [...config.allowedOrigins, origin] };
}
