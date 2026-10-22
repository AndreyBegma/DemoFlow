import { type Locator, pressKeyProblem, type StepInput } from '@demoflow/core';
import { slug } from './paths.ts';

// The scenario step a resolved Playwright call stands for (spec 208, Decision
// 3), or the reason it has none (Decision 4). Pure: the fixture decides
// whether a reason fails the test or becomes an annotation.

export type Mapped = { step: StepInput } | { reason: string };

const TIMEOUT_MIN = 100;
const TIMEOUT_MAX = 60_000;

/**
 * Options an action may carry without changing what it does. Anything else
 * (`button`, `modifiers`, `position`, `trial`, …) changes the action, and a
 * replay without it would diverge.
 */
const NEUTRAL_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  click: ['force', 'noWaitAfter', 'timeout'],
  hover: ['force', 'noWaitAfter', 'timeout'],
  fill: ['force', 'noWaitAfter', 'timeout'],
  selectOption: ['force', 'noWaitAfter', 'timeout'],
  press: ['noWaitAfter', 'timeout'],
  waitFor: ['state', 'timeout'],
};

/** Why `options` changes what `action` does, or `undefined`. */
export function actionOptionsProblem(
  action: string,
  options: unknown,
): string | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) {
    return 'options that are not an object';
  }
  const allowed = NEUTRAL_OPTIONS[action] ?? [];
  const extra = Object.entries(options)
    .filter(([name, value]) => value !== undefined && !allowed.includes(name))
    .map(([name]) => name);
  return extra.length === 0
    ? undefined
    : `the option ${extra.join(', ')} has no scenario form`;
}

/**
 * `page.goto(url)`: a `path` when the URL is under the test's `baseURL`, so the
 * project's config decides where the replay runs; otherwise the URL itself.
 */
export function navigateStep(
  url: unknown,
  baseURL: string | undefined,
): Mapped {
  if (typeof url !== 'string') return { reason: 'a URL that is not a string' };
  let resolved: URL;
  try {
    resolved = baseURL === undefined ? new URL(url) : new URL(url, baseURL);
  } catch {
    return { reason: 'a URL that does not parse' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return {
      reason: `a ${resolved.protocol} URL; scenarios navigate over http(s)`,
    };
  }
  if (baseURL !== undefined) {
    const base = new URL(baseURL);
    const prefix = base.pathname.endsWith('/')
      ? base.pathname
      : `${base.pathname}/`;
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    const under =
      resolved.origin === base.origin &&
      (resolved.pathname === base.pathname ||
        resolved.pathname.startsWith(prefix));
    if (under && /^\/(?![/\\])/.test(path)) {
      return { step: { action: 'navigate', path } };
    }
  }
  return { step: { action: 'navigate', url: resolved.href } };
}

/** `locator.selectOption(o)`: one string, or an array of one. */
export function selectStep(target: Locator, option: unknown): Mapped {
  const single =
    Array.isArray(option) && option.length === 1 ? option[0] : option;
  if (typeof single !== 'string') {
    return Array.isArray(option)
      ? { reason: `${option.length} options; a scenario selects one` }
      : { reason: 'an option that is not a string' };
  }
  return { step: { action: 'select', target, option: single } };
}

/** `locator.press(key)`, when the key is one a scenario can send. */
export function pressStep(target: Locator, key: unknown): Mapped {
  if (typeof key !== 'string') return { reason: 'a key that is not a string' };
  const problem = pressKeyProblem(key);
  return problem === undefined
    ? { step: { action: 'press', key, target } }
    : { reason: `the key ${JSON.stringify(key)}: ${problem}` };
}

/** `locator.waitFor({ state?, timeout? })`. */
export function waitForStep(target: Locator, options: unknown): Mapped {
  const { state = 'visible', timeout } = (options ?? {}) as {
    state?: unknown;
    timeout?: unknown;
  };
  if (state !== 'visible' && state !== 'hidden') {
    return {
      reason: `the state ${String(state)}; a scenario waits for visible or hidden`,
    };
  }
  const timeoutMs =
    typeof timeout === 'number' &&
    Number.isInteger(timeout) &&
    timeout >= TIMEOUT_MIN &&
    timeout <= TIMEOUT_MAX
      ? { timeoutMs: timeout }
      : {};
  return { step: { action: 'waitFor', target, state, ...timeoutMs } };
}

/** `page.screenshot({ path })`: named after the file, without its extension. */
export function screenshotStep(options: unknown): Mapped {
  const file = (options as { path?: unknown } | undefined)?.path;
  if (typeof file !== 'string' || file === '') {
    return { reason: 'a screenshot without a path has no name' };
  }
  const base = file.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const name = slug(dot > 0 ? base.slice(0, dot) : base);
  return { step: { action: 'screenshot', name } };
}

/** The page's scroll position, read in the browser. */
export interface ScrollPosition {
  x: number;
  y: number;
  /** The largest `y` the page can reach. */
  maxY: number;
}

/**
 * A page scroll, from its effect: `undefined` when the page did not move, a
 * step when it ended at the top or the bottom, otherwise the reason.
 */
export function scrollStep(
  before: ScrollPosition,
  after: ScrollPosition,
): Mapped | undefined {
  if (before.x === after.x && before.y === after.y) return undefined;
  if (before.y === after.y) {
    return { reason: 'a horizontal scroll has no scenario form' };
  }
  if (after.y <= 0) return { step: { action: 'scroll', to: 'top' } };
  // Fractional device pixels: within a pixel of the end is the end.
  if (after.y >= after.maxY - 1) {
    return { step: { action: 'scroll', to: 'bottom' } };
  }
  return { reason: 'the scroll ended between the top and the bottom' };
}

const TEXT_MATCHERS: Readonly<Record<string, 'exact' | 'contains'>> = {
  toHaveText: 'exact',
  toContainText: 'contains',
};

/** `expect(locator)[.not].<matcher>(...args)`. */
export function assertionStep(
  matcher: string,
  target: Locator,
  args: readonly unknown[],
  negated: boolean,
): Mapped {
  if (negated) return { reason: 'a negated assertion has no scenario form' };
  const [expected, options] =
    matcher === 'toBeVisible' ? [undefined, args[0]] : args;
  const optionsProblem = extraAssertionOptions(options);
  if (matcher === 'toBeVisible') {
    if (optionsProblem !== undefined) return { reason: optionsProblem };
    return { step: { action: 'assertVisible', target } };
  }
  const match = TEXT_MATCHERS[matcher];
  if (match === undefined) {
    return { reason: `${matcher} has no scenario form` };
  }
  if (typeof expected !== 'string') {
    return {
      reason:
        expected instanceof RegExp
          ? 'a regular expression has no scenario form'
          : 'only a string has a scenario form',
    };
  }
  if (expected === '') return { reason: 'an empty text has no scenario form' };
  if (optionsProblem !== undefined) return { reason: optionsProblem };
  return { step: { action: 'assertText', target, text: expected, match } };
}

function extraAssertionOptions(options: unknown): string | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) {
    return 'options that are not an object';
  }
  const extra = Object.entries(options)
    .filter(([name, value]) => value !== undefined && name !== 'timeout')
    .map(([name]) => name);
  return extra.length === 0
    ? undefined
    : `the option ${extra.join(', ')} has no scenario form`;
}
