import type { Locator, StepInput } from '@demoflow/core';
import type { Page, Locator as PwLocator } from '@playwright/test';
import {
  type Described,
  derivedReason,
  describeLocator,
  isLocatorFactory,
} from './locator.ts';
import { type Recorder, stackHere } from './recorder.ts';
import { scrolling, wheeling } from './scroll.ts';
import { envNameOf } from './secrets.ts';
import {
  actionOptionsProblem,
  type Mapped,
  navigateStep,
  pressStep,
  screenshotStep,
  selectStep,
  waitForStep,
} from './steps.ts';

// The recording `page` (spec 208, Decision 2): a Proxy over the real `Page`
// whose locators are Proxies over the real `Locator`, each carrying its
// scenario form. Every property the fixture does not record is the real one,
// bound to the real object.

type AnyFunction = (...args: unknown[]) => unknown;

/** What a wrapped object stands for: `expect` reads it to unwrap and record. */
export interface Wrapped {
  real: object;
  recorder: Recorder;
  /** A locator's scenario form; absent on the page. */
  described?: Described;
}

const wrapped = new WeakMap<object, Wrapped>();

export function wrappedOf(value: unknown): Wrapped | undefined {
  return typeof value === 'object' && value !== null
    ? wrapped.get(value)
    : undefined;
}

/** The real object behind a wrapper, or the value itself. */
function unwrap(value: unknown): unknown {
  return wrappedOf(value)?.real ?? value;
}

/** Arguments with wrappers replaced, one level into plain objects (`{ has }`). */
function unwrapArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (wrappedOf(arg) !== undefined) return unwrap(arg);
    if (
      typeof arg === 'object' &&
      arg !== null &&
      Object.getPrototypeOf(arg) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(arg).map(([key, value]) => [key, unwrap(value)]),
      );
    }
    return arg;
  });
}

/** Locator calls that change the page and have no scenario form. */
const UNRECORDABLE_LOCATOR_ACTIONS = new Set([
  'check',
  'uncheck',
  'setChecked',
  'dblclick',
  'tap',
  'type',
  'pressSequentially',
  'clear',
  'setInputFiles',
  'dragTo',
  'dispatchEvent',
  'selectText',
]);

/** Locator calls that build another locator (or frame locator) from this one. */
const DERIVING = new Set([
  'first',
  'last',
  'nth',
  'filter',
  'and',
  'or',
  'locator',
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByTestId',
  'getByAltText',
  'getByTitle',
  'frameLocator',
  'contentFrame',
  'owner',
]);

/** Page calls that change the page and have no scenario form. */
const UNRECORDABLE_PAGE_ACTIONS: Readonly<Record<string, string>> = {
  reload: 'a reload has no scenario form',
  goBack: 'history navigation has no scenario form',
  goForward: 'history navigation has no scenario form',
  setContent: 'replacing the document has no scenario form',
};

/** Selector-based page actions, the older form of a locator action. */
const PAGE_SELECTOR_ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'hover',
  'press',
  'selectOption',
  'check',
  'uncheck',
  'setChecked',
  'tap',
  'type',
  'dispatchEvent',
  'setInputFiles',
  'dragAndDrop',
]);

const UNRECORDABLE_MOUSE = new Set(['click', 'dblclick', 'down', 'up', 'move']);

function bound(target: object, value: AnyFunction): AnyFunction {
  return (...args) => Reflect.apply(value, target, unwrapArgs(args));
}

/** A rejected call, with the refusal kept on the recorder. */
function refused(error: Error): Promise<never> {
  return Promise.reject(error);
}

export function wrapPage(page: Page, recorder: Recorder): Page {
  const mouse = wrapMouse(page, recorder);
  const keyboard = refuseAll(page.keyboard, 'page.keyboard', recorder);
  const touchscreen = refuseAll(page.touchscreen, 'page.touchscreen', recorder);
  const proxy = new Proxy(page, {
    get(target, property) {
      if (property === 'mouse') return mouse;
      if (property === 'keyboard') return keyboard;
      if (property === 'touchscreen') return touchscreen;
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property === 'symbol') {
        return value;
      }
      const call = bound(target, value as AnyFunction);
      const name = property;
      if (isLocatorFactory(name)) {
        return (...args: unknown[]) =>
          wrapLocator(
            call(...args) as PwLocator,
            describeLocator(name, args),
            recorder,
          );
      }
      if (name === 'getByAltText' || name === 'getByTitle') {
        return (...args: unknown[]) =>
          wrapLocator(
            call(...args) as PwLocator,
            { reason: `${name}() has no scenario form` },
            recorder,
          );
      }
      if (name === 'frameLocator') {
        return (...args: unknown[]) =>
          wrapLocator(
            call(...args) as PwLocator,
            { reason: derivedReason(name) },
            recorder,
          );
      }
      const unrecordable = UNRECORDABLE_PAGE_ACTIONS[name];
      if (unrecordable !== undefined) {
        return () =>
          refused(
            recorder.cannotRecord(`page.${name}`, stackHere(), unrecordable),
          );
      }
      if (PAGE_SELECTOR_ACTIONS.has(name)) {
        return () =>
          refused(
            recorder.cannotRecord(
              `page.${name}`,
              stackHere(),
              'a selector action has no scenario form; use a locator',
            ),
          );
      }
      switch (name) {
        case 'goto':
          return (url: unknown, ...rest: unknown[]) => {
            const mapped = navigateStep(
              url,
              recorder.testInfo.project.use.baseURL,
            );
            return record(recorder, 'page.goto', stackHere(), mapped, () =>
              call(url, ...rest),
            );
          };
        case 'screenshot':
          return async (...args: unknown[]) => {
            const stack = stackHere();
            const result = await call(...args);
            const mapped = screenshotStep(args[0]);
            if ('step' in mapped) recorder.push(mapped.step);
            else recorder.omit('page.screenshot', stack, mapped.reason);
            return result;
          };
        case 'evaluate':
          return (...args: unknown[]) =>
            scrolling(recorder, 'page.evaluate', stackHere(), () =>
              call(...args),
            );
        default:
          return call;
      }
    },
  });
  wrapped.set(proxy, { real: page, recorder });
  return proxy;
}

/**
 * Runs a call that maps to `mapped`: a reason refuses it before it runs, a
 * step is recorded once it resolves. A call that throws records nothing.
 */
async function record(
  recorder: Recorder,
  call: string,
  stack: string,
  mapped: Mapped,
  run: () => unknown,
): Promise<unknown> {
  if ('reason' in mapped) {
    throw recorder.cannotRecord(call, stack, mapped.reason);
  }
  const result = await run();
  recorder.push(mapped.step);
  return result;
}

function wrapLocator(
  locator: PwLocator,
  described: Described,
  recorder: Recorder,
): PwLocator {
  const proxy = new Proxy(locator, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property === 'symbol') {
        return value;
      }
      const call = bound(target, value as AnyFunction);
      const name = property;
      if (DERIVING.has(name)) {
        return (...args: unknown[]) =>
          wrapLocator(
            call(...args) as PwLocator,
            { reason: derivedReason(name) },
            recorder,
          );
      }
      if (name === 'describe') {
        return (...args: unknown[]) =>
          wrapLocator(call(...args) as PwLocator, described, recorder);
      }
      if (name === 'all') {
        return async () =>
          ((await call()) as PwLocator[]).map((each) =>
            wrapLocator(each, { reason: derivedReason('all') }, recorder),
          );
      }
      if (UNRECORDABLE_LOCATOR_ACTIONS.has(name)) {
        return () =>
          refused(
            recorder.cannotRecord(
              `locator.${name}`,
              stackHere(),
              `${name}() has no scenario form`,
            ),
          );
      }
      const optionsAt = OPTIONS_ARGUMENT[name];
      if (optionsAt === undefined) return call;
      return (...args: unknown[]) => {
        const stack = stackHere();
        const where = `locator.${name}`;
        if ('reason' in described) {
          return refused(recorder.cannotRecord(where, stack, described.reason));
        }
        const problem = actionOptionsProblem(name, args[optionsAt]);
        if (problem !== undefined) {
          return refused(recorder.cannotRecord(where, stack, problem));
        }
        if (name === 'fill') {
          return fill(target, described.locator, recorder, stack, call, args);
        }
        return record(
          recorder,
          where,
          stack,
          actionStep(name, described.locator, args),
          () => call(...args),
        );
      };
    },
  });
  wrapped.set(proxy, { real: locator, recorder, described });
  return proxy;
}

/** The recorded locator actions, and which argument holds their options. */
const OPTIONS_ARGUMENT: Readonly<Record<string, number>> = {
  click: 0,
  hover: 0,
  fill: 1,
  selectOption: 1,
  press: 1,
  waitFor: 0,
  scrollIntoViewIfNeeded: 0,
};

/** The step of a recorded locator action other than `fill`. */
function actionStep(name: string, target: Locator, args: unknown[]): Mapped {
  switch (name) {
    case 'click':
      return { step: { action: 'click', target } };
    case 'hover':
      return { step: { action: 'hover', target } };
    case 'selectOption':
      return selectStep(target, args[0]);
    case 'press':
      return pressStep(target, args[0]);
    case 'scrollIntoViewIfNeeded':
      return { step: { action: 'scroll', target } };
    default:
      return waitForStep(target, args[0]);
  }
}

const isPasswordField = (element: Element): boolean =>
  element instanceof HTMLInputElement && element.type === 'password';

/**
 * A fill (spec 208, Decision 5): a value an environment variable holds is
 * recorded as that variable; any other value in a password field refuses.
 */
async function fill(
  locator: PwLocator,
  target: Locator,
  recorder: Recorder,
  stack: string,
  call: AnyFunction,
  args: unknown[],
): Promise<unknown> {
  const [value] = args;
  if (typeof value !== 'string') {
    throw recorder.cannotRecord(
      'locator.fill',
      stack,
      'a value that is not a string',
    );
  }
  const env = envNameOf(value, process.env);
  if (env !== undefined) {
    const result = await call(...args);
    recorder.push({ action: 'fill', target, valueFrom: { env } });
    return result;
  }
  // Asked before the fill, so a password is never typed before it is refused.
  // A field that cannot be read now (not attached yet) is asked again after.
  let password = await locator.evaluate(isPasswordField).catch(() => undefined);
  if (password === true) throw refusePassword(recorder, stack);
  const result = await call(...args);
  password ??= await locator.evaluate(isPasswordField).catch(() => undefined);
  if (password === undefined) {
    throw recorder.cannotRecord(
      'locator.fill',
      stack,
      'could not tell whether the field is a password',
    );
  }
  if (password) throw refusePassword(recorder, stack);
  const step: StepInput = { action: 'fill', target, value };
  recorder.push(step);
  return result;
}

function refusePassword(recorder: Recorder, stack: string): Error {
  return recorder.refuse(
    `refusing to record a password at ${recorder.where(stack)}: fill it from an environment variable`,
  );
}

function wrapMouse(page: Page, recorder: Recorder): Page['mouse'] {
  const mouse = page.mouse;
  return new Proxy(mouse, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property === 'symbol') {
        return value;
      }
      const call = bound(target, value as AnyFunction);
      if (UNRECORDABLE_MOUSE.has(property)) {
        return () =>
          refused(
            recorder.cannotRecord(
              `page.mouse.${property}`,
              stackHere(),
              'raw mouse input has no scenario form; use a locator',
            ),
          );
      }
      if (property === 'wheel') {
        return (...args: unknown[]) => {
          const stack = stackHere();
          const run = () => call(...args);
          // Only a vertical wheel can scroll a container to its top or bottom.
          return typeof args[1] === 'number' && args[1] !== 0
            ? wheeling(recorder, stack, run)
            : scrolling(recorder, 'page.mouse.wheel', stack, run);
        };
      }
      return call;
    },
  });
}

/** An object every method of which refuses: `page.keyboard`, `page.touchscreen`. */
function refuseAll<T extends object>(
  object: T,
  name: string,
  recorder: Recorder,
): T {
  return new Proxy(object, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property === 'symbol') {
        return value;
      }
      return () =>
        refused(
          recorder.cannotRecord(
            `${name}.${property}`,
            stackHere(),
            'raw input has no scenario form; use a locator action',
          ),
        );
    },
  });
}
