import type { z } from 'zod';
import {
  type ConfigVariables,
  resolveConfigTemplates,
} from './config-template.ts';
import { expandSteps } from './expand.ts';
import { formatPath, type Issue, toIssues } from './issues.ts';
import { isCssLocator, type Locator } from './locator.ts';
import { type ProjectConfig, ProjectConfigSchema } from './project-config.ts';
import { type Scenario, ScenarioSchema } from './scenario.ts';
import type { Step, TemplateStep } from './step.ts';

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

/**
 * Validates a scenario and applies its defaults, then its `{{…}}`
 * substitution: every expanded step must be a valid step (spec 165). Warns on
 * every `{ css }` locator.
 */
export function parseScenario(input: unknown): ParseResult<Scenario> {
  const result = parseWith(ScenarioSchema, input);
  if (!result.ok) return result;
  const { issues } = expandSteps(result.value);
  if (issues.length > 0) return { ok: false, errors: issues };
  const warnings: Issue[] = [];
  const warn = (
    path: readonly PropertyKey[],
    step: Step | TemplateStep,
  ): void => {
    const locators: [string, Locator | undefined][] = [
      ['target', 'target' in step ? step.target : undefined],
      ['within', 'within' in step ? step.within : undefined],
    ];
    for (const [key, locator] of locators) {
      if (locator !== undefined && isCssLocator(locator)) {
        warnings.push({
          path: formatPath([...path, key]),
          code: 'css-locator',
          message:
            'a CSS selector breaks when the markup changes; prefer role, label, testId, text or placeholder',
        });
      }
    }
  };
  result.value.steps.forEach((step, index) => {
    if (step.action === 'repeat') {
      step.steps.forEach((inner, innerIndex) => {
        warn(['steps', index, 'steps', innerIndex], inner);
      });
    } else {
      warn(['steps', index], step);
    }
  });
  return { ok: true, value: result.value, warnings };
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
