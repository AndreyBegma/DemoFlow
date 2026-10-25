import { z } from 'zod';
import { JsonSchemaRefSchema } from './common.ts';
import {
  checkTemplates,
  mapStrings,
  substitute,
  validateStep,
} from './expand.ts';
import { formatPath, type Issue, toIssues } from './issues.ts';
import { cssLocatorWarnings } from './locator.ts';
import type { Scenario } from './scenario.ts';
import {
  DataKeySchema,
  FragmentStepSchema,
  type IncludeStep,
  ParamValueSchema,
  type ScenarioStep,
  type Step,
} from './step.ts';
import {
  type DataValue,
  type Placeholder,
  type TemplateScope,
} from './template.ts';

/** Where fragment files live when `demoflow.config.json` names no `fragmentsDir`. */
export const DEFAULT_FRAGMENTS_DIR = 'demoflow/fragments';

/** The name a fragment's steps call its parameters by: `{{params.next}}`. */
export const PARAMS = 'params';

/** Includes nest at most this deep: a fragment that includes one that includes … */
export const MAX_INCLUDE_DEPTH = 8;

/**
 * `setup` and `steps` each hold at most this many steps once their includes
 * are inlined, as a scenario does: the resolved scenario parses again.
 */
export const MAX_INLINED_STEPS = 200;

export const FragmentParamSchema = z.strictObject({
  description: z.string().optional(),
  default: ParamValueSchema.optional().meta({
    description:
      'The value when an include gives none. Without a default the parameter is required.',
  }),
});
export type FragmentParam = z.infer<typeof FragmentParamSchema>;

/**
 * A fragment file, `<fragmentsDir>/<name>.json` (spec 171): steps a scenario
 * runs with `{ "action": "include", "fragment": "<name>" }`, their strings
 * filled in from the include's `with` through `{{params.<name>}}`.
 */
export const FragmentSchema = z
  .strictObject({
    $schema: JsonSchemaRefSchema,
    schemaVersion: z.literal(1),
    description: z.string().optional(),
    params: z.record(DataKeySchema, FragmentParamSchema).optional().meta({
      description:
        'The parameters the steps use as {{params.<name>}}, by name.',
    }),
    steps: z
      .array(FragmentStepSchema)
      .min(1, 'expected at least one step')
      .max(200, 'expected at most 200 steps'),
  })
  .meta({
    title: 'DemoFlow fragment',
    description:
      'Reusable steps a scenario runs with an include step, such as signing in.',
  });
export type Fragment = z.infer<typeof FragmentSchema>;
export type FragmentInput = z.input<typeof FragmentSchema>;

/**
 * A fragment file as read, by its name. `file` is how messages name it — the
 * path relative to the project root. `missing` when there is no such file.
 */
export type FragmentLoad =
  | { ok: true; file: string; value: unknown }
  | { ok: false; file: string; missing: boolean; message: string };

/** Reads fragments; injected so the core reads no file itself (ADR-0001). */
export type FragmentSource = (name: string) => FragmentLoad;

export interface Resolution {
  /** The scenario with every `include` replaced by its steps. */
  scenario: Scenario;
  issues: Issue[];
  /** `{ css }` locators in the fragments, at the include that runs them. */
  warnings: Issue[];
}

/** A step of a fragment file, or of the scenario when `chain` is empty. */
interface Place {
  /** The path in the scenario of the step or include it came from. */
  at: readonly PropertyKey[];
  /** The fragment files it was inlined through, outermost first, each at its step. */
  chain: readonly { file: string; path: readonly PropertyKey[] }[];
}

type Loaded =
  | { ok: true; file: string; fragment: Fragment }
  | { ok: false; file: string; code: string; message: string };

/**
 * Replaces every `include` of the scenario, in `setup` and `steps`, with the
 * steps of its fragment, parameters substituted (spec 171). The result is a
 * plain scenario: it parses again without any fragment, so a run's
 * `scenario.json` is complete. A problem inside a fragment is reported at the
 * include in the scenario, its message naming the fragment file and step.
 * Also checks that only the opening steps are off camera.
 */
export function resolveFragments(
  scenario: Scenario,
  source: FragmentSource | undefined,
): Resolution {
  const resolver = new Resolver(source);
  const setup =
    scenario.setup === undefined
      ? undefined
      : resolver.section(scenario.setup, 'setup');
  const steps = resolver.section(scenario.steps, 'steps');
  const { issues, warnings } = resolver;
  // Includes that failed leave gaps the off-camera rule would misread.
  if (issues.length === 0) checkOffCamera(setup ?? [], steps, issues);
  const resolved: Scenario = {
    ...scenario,
    ...(setup === undefined
      ? {}
      : { setup: setup.map((entry) => entry.step as Step) }),
    steps: steps.map((entry) => entry.step),
  };
  return { scenario: resolved, issues, warnings };
}

interface Entry {
  step: ScenarioStep;
  place: Place;
  /** Off camera through an include with `record: false`. */
  hidden: boolean;
}

class Resolver {
  readonly issues: Issue[] = [];
  readonly warnings: Issue[] = [];
  readonly #source: FragmentSource | undefined;
  readonly #cache = new Map<string, Loaded>();
  /** Fragments whose own problems were reported: once, at the first include. */
  readonly #reported = new Set<string>();
  #inlined = 0;
  #tooMany = false;

  constructor(source: FragmentSource | undefined) {
    this.#source = source;
  }

  /** The steps of `setup` or `steps`, includes inlined. */
  section(steps: readonly ScenarioStep[], key: 'setup' | 'steps'): Entry[] {
    this.#inlined = 0;
    this.#tooMany = false;
    return steps.flatMap((step, index) => {
      const place: Place = { at: [key, index], chain: [] };
      if (step.action === 'include') {
        return this.#include(step, place, undefined, [], false);
      }
      return this.#count(place) ? [{ step, place, hidden: false }] : [];
    });
  }

  /** Counts one more step of the section; `false` once there are too many. */
  #count(place: Place): boolean {
    if (++this.#inlined <= MAX_INLINED_STEPS) return true;
    if (!this.#tooMany) {
      this.#tooMany = true;
      this.issues.push({
        path: formatPath(place.at),
        code: 'too-many-steps',
        message: `expected at most ${MAX_INLINED_STEPS} steps in ${String(place.at[0])} once includes are inlined`,
      });
    }
    return false;
  }

  #include(
    include: IncludeStep,
    place: Place,
    scope: TemplateScope | undefined,
    stack: readonly string[],
    hidden: boolean,
  ): Entry[] {
    const name = include.fragment;
    if (stack.includes(name)) {
      this.#issue(
        place,
        ['fragment'],
        'fragment-cycle',
        `cyclic include: ${[...stack, name].join(' → ')}`,
      );
      return [];
    }
    if (stack.length >= MAX_INCLUDE_DEPTH) {
      this.#issue(
        place,
        ['fragment'],
        'fragment-depth',
        `expected includes at most ${MAX_INCLUDE_DEPTH} deep: ${[...stack, name].join(' → ')}`,
      );
      return [];
    }
    const loaded = this.#load(name, place);
    if (!loaded.ok) {
      this.#issue(place, ['fragment'], loaded.code, loaded.message);
      return [];
    }
    const { file, fragment } = loaded;
    const params = this.#params(include, place, scope, file, fragment);
    if (params === undefined) return [];

    const inner: TemplateScope = { name: PARAMS, item: params, index: 0 };
    const off = hidden || include.record === false;
    const entries: Entry[] = [];
    for (const [index, step] of fragment.steps.entries()) {
      const at = { file, path: ['steps', index] };
      const child: Place = { at: place.at, chain: [...place.chain, at] };
      if (step.action === 'include') {
        entries.push(
          ...this.#include(step, child, inner, [...stack, name], off),
        );
        continue;
      }
      const issues: Issue[] = [];
      const valid = validateStep(substitute(step, inner), [], '', issues);
      for (const issue of issues) {
        this.#issue(child, [], issue.code, issue.message, issue.path);
      }
      if (valid === undefined) continue;
      if (!this.#count(place)) return entries;
      // Scenario text again: the expansion reads `\{{` as `{{` once more.
      const text = mapStrings(valid, [], escapeTemplate) as Step;
      entries.push({
        step: off ? { ...text, record: false } : text,
        place: child,
        hidden: off,
      });
    }
    return entries;
  }

  /** The include's parameter values, defaults filled in; `undefined` on a problem. */
  #params(
    include: IncludeStep,
    place: Place,
    scope: TemplateScope | undefined,
    file: string,
    fragment: Fragment,
  ): Record<string, DataValue> | undefined {
    const declared = fragment.params ?? {};
    const names = Object.keys(declared);
    const values: Record<string, DataValue> = {};
    let ok = true;
    for (const [key, value] of Object.entries(include.with ?? {})) {
      if (!(key in declared)) {
        this.#issue(
          place,
          ['with', key],
          'unknown-parameter',
          `unknown parameter ${key}: ${file} takes ${
            names.length === 0 ? 'no parameters' : names.join('|')
          }`,
        );
        ok = false;
        continue;
      }
      if (typeof value !== 'string') {
        values[key] = value;
        continue;
      }
      // In a fragment the value may pass on one of its own parameters;
      // in the scenario there are none to pass on.
      const issues: Issue[] = [];
      const usable = checkTemplates(
        value,
        ['with', key],
        scope === undefined ? outsideFragment : () => undefined,
        issues,
      );
      for (const issue of issues) {
        this.#issue(place, [], issue.code, issue.message, issue.path);
      }
      if (!usable) {
        ok = false;
        continue;
      }
      values[key] = substitute(value, scope) as string;
    }
    for (const [key, param] of Object.entries(declared)) {
      if (key in values || include.with?.[key] !== undefined) continue;
      if (param.default !== undefined) {
        values[key] = param.default;
        continue;
      }
      this.#issue(
        place,
        ['with'],
        'missing-parameter',
        `missing parameter ${key}: ${file} has no default for it`,
      );
      ok = false;
    }
    return ok ? values : undefined;
  }

  #load(name: string, place: Place): Loaded {
    let loaded = this.#cache.get(name);
    if (loaded === undefined) {
      loaded = this.#read(name);
      this.#cache.set(name, loaded);
    }
    if (!loaded.ok || this.#reported.has(name)) return loaded;
    this.#reported.add(name);
    const { file, fragment } = loaded;
    for (const [index, step] of fragment.steps.entries()) {
      for (const warning of cssLocatorWarnings(step, ['steps', index])) {
        this.warnings.push(this.#located(place, file, warning));
      }
    }
    return loaded;
  }

  #read(name: string): Loaded {
    if (this.#source === undefined) {
      return {
        ok: false,
        file: name,
        code: 'no-fragments',
        message: `cannot include ${name}: fragments are read from a project's fragments directory, and none is known here`,
      };
    }
    const load = this.#source(name);
    if (!load.ok) {
      return {
        ok: false,
        file: load.file,
        code: load.missing ? 'unknown-fragment' : 'fragment-unreadable',
        message: load.missing
          ? `unknown fragment ${name}: no ${load.file}`
          : `cannot read ${load.file}: ${load.message}`,
      };
    }
    const parsed = FragmentSchema.safeParse(load.value);
    const problems: Issue[] = parsed.success
      ? []
      : toIssues(parsed.error.issues);
    if (parsed.success) {
      const names = Object.keys(parsed.data.params ?? {});
      const check = (placeholder: Placeholder): string | undefined => {
        if (placeholder.kind === 'index') {
          return 'expected {{index}} only inside a repeat';
        }
        if (placeholder.name !== PARAMS) {
          return `expected {{${PARAMS}.<name>}} in a fragment, found {{${placeholder.name}.${placeholder.field}}}`;
        }
        return names.includes(placeholder.field)
          ? undefined
          : `unknown parameter ${placeholder.field}: ${load.file} declares ${
              names.length === 0 ? 'none' : names.join('|')
            }`;
      };
      for (const [index, step] of parsed.data.steps.entries()) {
        checkTemplates(step, ['steps', index], check, problems);
      }
    }
    if (problems.length > 0 || !parsed.success) {
      return {
        ok: false,
        file: load.file,
        code: 'invalid-fragment',
        message: problems
          .map(
            (issue) =>
              `${load.file}${issue.path === '' ? '' : ` ${issue.path}`}: ${issue.message}`,
          )
          .join('; '),
      };
    }
    return { ok: true, file: load.file, fragment: parsed.data };
  }

  /**
   * At the scenario path of the include when the place is in a fragment, the
   * message naming each fragment file and step on the way: `in a.json
   * steps[0] → b.json steps[2].path: …`.
   */
  #issue(
    place: Place,
    sub: readonly PropertyKey[],
    code: string,
    message: string,
    innerPath = '',
  ): void {
    if (place.chain.length === 0) {
      const path = formatPath([...place.at, ...sub]);
      this.issues.push({
        path: innerPath === '' ? path : `${path}.${innerPath}`,
        code,
        message,
      });
      return;
    }
    this.issues.push({
      path: formatPath(place.at),
      code,
      message: `in ${describeChain(place, sub, innerPath)}: ${message}`,
    });
  }

  #located(place: Place, file: string, warning: Issue): Issue {
    const chain = [...place.chain.map(show), file].join(' → ');
    return {
      ...warning,
      path: formatPath(place.at),
      message: `in ${chain} ${warning.path}: ${warning.message}`,
    };
  }
}

function show(link: Place['chain'][number]): string {
  return `${link.file} ${formatPath(link.path)}`;
}

function describeChain(
  place: Place,
  sub: readonly PropertyKey[],
  innerPath: string,
): string {
  const links = place.chain.map((link, index) => {
    if (index < place.chain.length - 1) return show(link);
    const path = formatPath([...link.path, ...sub]);
    return `${link.file} ${innerPath === '' ? path : joinPath(path, innerPath)}`;
  });
  return links.join(' → ');
}

/** `steps[2]` and `target.name` → `steps[2].target.name`; `[0]` joins bare. */
function joinPath(path: string, inner: string): string {
  return inner.startsWith('[') ? `${path}${inner}` : `${path}.${inner}`;
}

function outsideFragment(placeholder: Placeholder): string {
  return placeholder.kind === 'index'
    ? 'expected {{index}} only inside a repeat'
    : `expected {{${placeholder.name}.${placeholder.field}}} only in a fragment`;
}

/** Text that renders as `text`: every `{{` written as `\{{`. */
function escapeTemplate(text: string): string {
  return text.replaceAll('{{', '\\{{');
}

/**
 * The off-camera rule (spec 171): `setup`, then the steps marked
 * `record: false`, and only then the recorded ones. A hidden span in the
 * middle would have to be cut from the video, so it is refused.
 */
function checkOffCamera(
  setup: readonly Entry[],
  steps: readonly Entry[],
  issues: Issue[],
): void {
  for (const { step, place } of setup) {
    if (place.chain.length === 0 && step.record === true) {
      issues.push({
        path: formatPath([...place.at, 'record']),
        code: 'record-in-setup',
        message: 'expected no record: true in setup: setup runs off camera',
      });
    }
  }
  let recorded = false;
  for (const { step, place, hidden } of steps) {
    if (step.action === 'repeat') {
      for (const [index, inner] of step.steps.entries()) {
        if (inner.record !== undefined) {
          issues.push({
            path: formatPath([...place.at, 'steps', index, 'record']),
            code: 'record-in-repeat',
            message: 'expected record on the repeat, not on a step inside it',
          });
        }
      }
    }
    if (!(hidden || step.record === false)) {
      recorded = true;
      continue;
    }
    if (recorded) {
      const where =
        place.chain.length === 0 ? '' : ` (in ${describeChain(place, [], '')})`;
      issues.push({
        path: formatPath(
          place.chain.length === 0 ? [...place.at, 'record'] : place.at,
        ),
        code: 'off-camera-after-recorded',
        message: `expected record: false only before the first recorded step: off-camera steps run before the recording starts${where}`,
      });
      return;
    }
  }
  if (!recorded) {
    issues.push({
      path: 'steps',
      code: 'nothing-recorded',
      message: 'expected at least one recorded step',
    });
  }
}
