import { z } from 'zod';
import { isCssLocator, type Locator } from './locator.ts';
import { type ProjectConfig, ProjectConfigSchema } from './project-config.ts';
import { type Scenario, ScenarioSchema } from './scenario.ts';

/** An error or warning, addressed by its path in the input: `steps[3].target`. */
export interface Issue {
  path: string;
  code: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; value: T; warnings: Issue[] }
  | { ok: false; errors: Issue[] };

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      if (/^[A-Za-z_$][\w$]*$/.test(key)) {
        out += out === '' ? key : `.${key}`;
      } else {
        out += `[${JSON.stringify(key)}]`;
      }
    }
  }
  return out;
}

function toIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): Issue[] {
  return issues.flatMap((issue): Issue[] => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: formatPath([...path, key]),
        code: issue.code,
        message: 'unknown field',
      }));
    }
    if (issue.code === 'invalid_union') {
      // When exactly one branch fails only below the root, the input meant
      // that branch: report its errors, not the whole union.
      const candidates = issue.errors.filter((branch) =>
        branch.every((inner) => inner.path.length > 0),
      );
      if (candidates.length === 1) return toIssues(candidates[0], path);
    }
    return [
      { path: formatPath(path), code: issue.code, message: issue.message },
    ];
  });
}

function parseWith<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; errors: Issue[] } {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: toIssues(result.error.issues) };
}

/** Validates a scenario and applies its defaults. Warns on every `{ css }` locator. */
export function parseScenario(input: unknown): ParseResult<Scenario> {
  const result = parseWith(ScenarioSchema, input);
  if (!result.ok) return result;
  const warnings: Issue[] = [];
  result.value.steps.forEach((step, index) => {
    const locators: [string, Locator | undefined][] = [
      ['target', 'target' in step ? step.target : undefined],
      ['within', 'within' in step ? step.within : undefined],
    ];
    for (const [key, locator] of locators) {
      if (locator !== undefined && isCssLocator(locator)) {
        warnings.push({
          path: formatPath(['steps', index, key]),
          code: 'css-locator',
          message:
            'a CSS selector breaks when the markup changes; prefer role, label, testId, text or placeholder',
        });
      }
    }
  });
  return { ok: true, value: result.value, warnings };
}

/** Validates `demoflow.config.json` and applies its defaults. */
export function parseProjectConfig(input: unknown): ParseResult<ProjectConfig> {
  const result = parseWith(ProjectConfigSchema, input);
  return result.ok ? { ...result, warnings: [] } : result;
}
