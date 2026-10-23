import type { Locator } from '@demoflow/core';

// The scenario form of a Playwright locator, read from the arguments of the
// factory that built it (spec 208, Decisions 3 and 4). A locator either maps
// one-to-one onto a scenario locator or carries the reason it cannot.

export type Described = { locator: Locator } | { reason: string };

/** `page` methods that build a locator from their arguments. */
export const LOCATOR_FACTORIES = [
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByTestId',
  'locator',
] as const;
export type LocatorFactory = (typeof LOCATOR_FACTORIES)[number];

export function isLocatorFactory(name: string): name is LocatorFactory {
  return (LOCATOR_FACTORIES as readonly string[]).includes(name);
}

/** Selector engines and chains a `{ css }` locator cannot express. */
const ENGINE_PREFIXES = ['text=', 'xpath=', 'internal:', '//'];

function reason(text: string): Described {
  return { reason: text };
}

function describeText(value: unknown, what: string): string | undefined {
  if (value instanceof RegExp) return `a regular expression as the ${what}`;
  if (typeof value !== 'string') return `a ${typeof value} as the ${what}`;
  if (value === '') return `an empty ${what}`;
  return undefined;
}

/** The option names in `options` outside `allowed`, as a reason. */
function extraOptions(
  options: unknown,
  allowed: readonly string[],
): string | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) {
    return 'options that are not an object';
  }
  const extra = Object.entries(options)
    .filter(([name, value]) => value !== undefined && !allowed.includes(name))
    .map(([name]) => name);
  return extra.length === 0
    ? undefined
    : `the option ${extra.join(', ')} has no scenario form`;
}

function exactOf(options: unknown): { exact?: true } | Described {
  const exact = (options as { exact?: unknown } | undefined)?.exact;
  if (exact === undefined || exact === false) return {};
  if (exact === true) return { exact: true };
  return reason('a non-boolean exact');
}

/** What `page.<factory>(...args)` stands for in a scenario. */
export function describeLocator(
  factory: LocatorFactory,
  args: readonly unknown[],
): Described {
  const [first, options] = args;
  switch (factory) {
    case 'getByRole': {
      const problem =
        describeText(first, 'role') ?? extraOptions(options, ['name', 'exact']);
      if (problem !== undefined) return reason(problem);
      const name = (options as { name?: unknown } | undefined)?.name;
      if (name !== undefined) {
        const nameProblem = describeText(name, 'name');
        // An empty name is a name: getByRole matches it literally.
        if (nameProblem !== undefined && name !== '')
          return reason(nameProblem);
      }
      const exact = exactOf(options);
      if ('reason' in exact) return exact;
      return {
        locator: {
          role: first as string,
          ...(name === undefined ? {} : { name: name as string }),
          ...exact,
        },
      };
    }
    case 'getByLabel':
    case 'getByText':
    case 'getByPlaceholder': {
      const key =
        factory === 'getByLabel'
          ? 'label'
          : factory === 'getByText'
            ? 'text'
            : 'placeholder';
      const problem =
        describeText(first, key) ?? extraOptions(options, ['exact']);
      if (problem !== undefined) return reason(problem);
      const exact = exactOf(options);
      if ('reason' in exact) return exact;
      const text = first as string;
      if (key === 'label') return { locator: { label: text, ...exact } };
      if (key === 'text') return { locator: { text, ...exact } };
      return { locator: { placeholder: text, ...exact } };
    }
    case 'getByTestId': {
      const problem =
        describeText(first, 'test id') ?? extraOptions(options, []);
      return problem === undefined
        ? { locator: { testId: first as string } }
        : reason(problem);
    }
    case 'locator': {
      if (typeof first !== 'string') {
        return reason('locator() of something other than a selector string');
      }
      if (options !== undefined) {
        return reason('locator() with options has no scenario form');
      }
      if (first.trim() === '') return reason('an empty selector');
      if (first.includes('>>')) return reason('a chained selector (>>)');
      const prefix = ENGINE_PREFIXES.find((engine) =>
        first.trimStart().startsWith(engine),
      );
      if (prefix !== undefined) {
        return reason(`a selector engine (${prefix}) other than CSS`);
      }
      return { locator: { css: first } };
    }
  }
}

/** The reason a locator built from another one has no scenario form. */
export function derivedReason(method: string): string {
  return `a locator built with ${method}() has no scenario form`;
}
