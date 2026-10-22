import type { z } from 'zod';
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

/** Validates `demoflow.config.json` and applies its defaults. */
export function parseProjectConfig(input: unknown): ParseResult<ProjectConfig> {
  const result = parseWith(ProjectConfigSchema, input);
  return result.ok ? { ...result, warnings: [] } : result;
}
