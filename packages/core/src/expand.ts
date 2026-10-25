import { formatPath, type Issue, toIssues } from './issues.ts';
import type { Scenario } from './scenario.ts';
import { type RepeatStep, type Step, StepSchema } from './step.ts';
import {
  type Placeholder,
  parseTemplate,
  placeholders,
  renderTemplate,
  type TemplateScope,
} from './template.ts';
import type { StepOrigin } from './timeline.ts';

/** A plain step the engine runs; `origin` when it came from a `repeat`. */
export type ExpandedStep = Step & { origin?: StepOrigin };

export interface Expansion {
  steps: ExpandedStep[];
  /** Every substitution problem, by step path; empty when the steps are usable. */
  issues: Issue[];
}

/**
 * Turns a scenario into the flat list of steps it runs (spec 165): every
 * `repeat` becomes its steps once per item, with `{{…}}` substituted, and
 * `\{{` becomes `{{` everywhere. `setup` comes first, off camera (ADR-0018).
 * Pure: zod only, no Node API (ADR-0001). Throws on a scenario
 * `parseScenario` would have rejected, and on an `include` it did not resolve.
 */
export function expandScenario(scenario: Scenario): { steps: ExpandedStep[] } {
  const { steps, issues } = expandSteps(scenario);
  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(`cannot expand the scenario: ${detail}`);
  }
  const hidden = offCameraSteps(steps);
  if (steps.slice(hidden).some((step) => step.record === false)) {
    throw new Error(
      'cannot expand the scenario: an off-camera step follows a recorded one',
    );
  }
  return { steps };
}

/** How many of the expanded steps open the scenario off camera (ADR-0018). */
export function offCameraSteps(steps: readonly ExpandedStep[]): number {
  const first = steps.findIndex((step) => step.record !== false);
  return first === -1 ? steps.length : first;
}

export interface ExpandOptions {
  /**
   * Leave `include` steps out instead of reporting them: `parseScenario`
   * checks the authored steps while the fragments are resolved apart.
   */
  skipIncludes?: boolean;
}

/** Expands the steps and collects every problem instead of throwing. */
export function expandSteps(
  scenario: Scenario,
  options: ExpandOptions = {},
): Expansion {
  const issues: Issue[] = [];
  const steps: ExpandedStep[] = [];
  const plain = (step: Step, at: readonly PropertyKey[]): Step | undefined =>
    checkTemplates(step, at, outsideRepeat, issues)
      ? validateStep(substitute(step), at, '', issues)
      : undefined;
  const unresolved = (at: readonly PropertyKey[]): void => {
    if (options.skipIncludes === true) return;
    issues.push({
      path: formatPath(at),
      code: 'unresolved-include',
      message:
        'expected the include to be resolved: parse the scenario with its fragments',
    });
  };
  for (const [index, step] of (scenario.setup ?? []).entries()) {
    const at = ['setup', index];
    if (step.action === 'include') {
      unresolved(at);
      continue;
    }
    const expanded = plain(step, at);
    if (expanded !== undefined) steps.push({ ...expanded, record: false });
  }
  for (const [index, step] of scenario.steps.entries()) {
    const at = ['steps', index];
    if (step.action === 'include') {
      unresolved(at);
      continue;
    }
    if (step.action === 'repeat') {
      steps.push(...expandRepeat(scenario, step, index, issues));
      continue;
    }
    const expanded = plain(step, at);
    if (expanded !== undefined) steps.push(expanded);
  }
  return { steps: issues.length > 0 ? [] : steps, issues };
}

function expandRepeat(
  scenario: Scenario,
  repeat: RepeatStep,
  repeatIndex: number,
  issues: Issue[],
): ExpandedStep[] {
  const at = ['steps', repeatIndex];
  const items = scenario.data?.[repeat.each];
  if (items === undefined) {
    const names = Object.keys(scenario.data ?? {});
    issues.push({
      path: formatPath([...at, 'each']),
      code: 'unknown-data-list',
      message: `unknown data list ${repeat.each}: ${
        names.length === 0
          ? 'the scenario has no data'
          : `expected one of ${names.join('|')}`
      }`,
    });
    return [];
  }

  const field = (placeholder: Placeholder): string | undefined => {
    if (placeholder.kind === 'index') return undefined;
    const { name } = placeholder;
    if (name !== repeat.as) {
      return `unknown name ${name}: this repeat calls its item ${repeat.as}`;
    }
    const missing = items.findIndex((item) => !(placeholder.field in item));
    return missing === -1
      ? undefined
      : `unknown field ${name}.${placeholder.field}: missing in data.${repeat.each}[${missing}]`;
  };
  const caption = { caption: repeat.caption };
  const usable = [
    checkTemplates(caption, at, shownOnce, issues),
    ...repeat.steps.map((step, index) =>
      checkTemplates(step, [...at, 'steps', index], field, issues),
    ),
  ].every(Boolean);
  if (!usable) return [];

  const steps: ExpandedStep[] = [];
  // An off-camera repeat is off camera in every iteration.
  const hidden = repeat.record === false ? { record: false } : {};
  // The repeat's caption is a caption marker before the first iteration.
  if (repeat.caption !== undefined && repeat.caption !== '') {
    const marker = validateStep(
      {
        action: 'marker',
        kind: 'caption',
        title: renderTemplate(template(repeat.caption)),
      },
      [...at, 'caption'],
      '',
      issues,
    );
    if (marker !== undefined) {
      steps.push({
        ...marker,
        ...hidden,
        origin: { repeatIndex, iteration: 0 },
      });
    }
  }
  // One report per step of the repeat: the first iteration it fails in.
  const failed = new Set<number>();
  for (const [iteration, item] of items.entries()) {
    const scope: TemplateScope = {
      name: repeat.as,
      item,
      index: iteration + 1,
    };
    for (const [index, step] of repeat.steps.entries()) {
      if (failed.has(index)) continue;
      const expanded = validateStep(
        substitute(step, scope),
        [...at, 'steps', index],
        ` (iteration ${iteration + 1})`,
        issues,
      );
      if (expanded === undefined) {
        failed.add(index);
      } else {
        steps.push({
          ...expanded,
          ...hidden,
          origin: { repeatIndex, iteration },
        });
      }
    }
  }
  return steps;
}

function outsideRepeat(placeholder: Placeholder): string {
  return `expected ${show(placeholder)} only inside a repeat`;
}

function shownOnce(placeholder: Placeholder): string {
  return `expected no ${show(placeholder)} in the caption of a repeat: it is shown once, before the first iteration`;
}

function show(placeholder: Placeholder): string {
  return placeholder.kind === 'index'
    ? '{{index}}'
    : `{{${placeholder.name}.${placeholder.field}}}`;
}

/**
 * Reports every string of `value` that is not a valid template, or holds a
 * placeholder `check` rejects. `true` when there is nothing to report.
 */
export function checkTemplates(
  value: unknown,
  at: readonly PropertyKey[],
  check: (placeholder: Placeholder) => string | undefined,
  issues: Issue[],
): boolean {
  const before = issues.length;
  mapStrings(value, at, (text, path) => {
    const parsed = parseTemplate(text);
    if (!parsed.ok) {
      issues.push({
        path: formatPath(path),
        code: 'template-syntax',
        message: parsed.message,
      });
      return text;
    }
    for (const placeholder of placeholders(parsed.template)) {
      const message = check(placeholder);
      if (message !== undefined) {
        issues.push({
          path: formatPath(path),
          code: 'template-placeholder',
          message,
        });
        break;
      }
    }
    return text;
  });
  return issues.length === before;
}

function template(text: string) {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.template;
}

export function substitute(value: unknown, scope?: TemplateScope): unknown {
  return mapStrings(value, [], (text) => renderTemplate(template(text), scope));
}

/** The substituted step checked as a plain step: formats hold once filled in. */
export function validateStep(
  value: unknown,
  at: readonly PropertyKey[],
  suffix: string,
  issues: Issue[],
): Step | undefined {
  const parsed = StepSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of toIssues(parsed.error.issues, at)) {
    issues.push({ ...issue, message: `${issue.message}${suffix}` });
  }
  return undefined;
}

/**
 * A copy of `value` with every string replaced by `fn`, except under
 * `valueFrom`: a secret's name is never a template.
 */
export function mapStrings(
  value: unknown,
  path: readonly PropertyKey[],
  fn: (text: string, path: readonly PropertyKey[]) => string,
): unknown {
  if (typeof value === 'string') return fn(value, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => mapStrings(entry, [...path, index], fn));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === 'valueFrom' ? entry : mapStrings(entry, [...path, key], fn),
      ]),
    );
  }
  return value;
}
