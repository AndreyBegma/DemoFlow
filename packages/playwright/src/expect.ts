import type { expect as baseExpect } from '@playwright/test';
import { activeRecorder, stackHere } from './recorder.ts';
import { assertionStep } from './steps.ts';
import { type Wrapped, wrappedOf } from './wrap.ts';

// The recording `expect` (spec 208, Decisions 2–4): matchers get the real,
// unwrapped page or locator, because they check its type. An assertion on a
// recording locator becomes a step when the scenario can express it; any
// other assertion on the page or its locators is left out and reported.

export type BaseExpect = typeof baseExpect;

type AnyFunction = (...args: unknown[]) => unknown;

/** Matchers that are not assertions on the subject. */
const MODIFIERS = new Set(['not', 'resolves', 'rejects']);

export function wrapExpect(expect: BaseExpect): BaseExpect {
  const call = wrapExpectCall(expect as unknown as AnyFunction, 'expect');
  return new Proxy(expect, {
    apply(_target, self, args: unknown[]) {
      return Reflect.apply(call, self, args);
    },
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      const fn = value as AnyFunction;
      switch (property) {
        case 'soft':
          return wrapExpectCall(bindTo(target, fn), 'expect.soft');
        case 'poll':
          return (...args: unknown[]) => {
            activeRecorder()?.omit(
              'expect.poll',
              stackHere(),
              'a polled assertion has no scenario form',
            );
            return Reflect.apply(fn, target, args);
          };
        case 'configure':
        case 'extend':
          return (...args: unknown[]) =>
            wrapExpect(Reflect.apply(fn, target, args) as BaseExpect);
        default:
          return bindTo(target, fn);
      }
    },
  });
}

function bindTo(target: object, fn: AnyFunction): AnyFunction {
  return (...args) => Reflect.apply(fn, target, args);
}

function wrapExpectCall(expect: AnyFunction, name: string): AnyFunction {
  return (subject: unknown, ...rest: unknown[]) => {
    const wrapper = wrappedOf(subject);
    const matchers = expect(wrapper?.real ?? subject, ...rest);
    if (wrapper === undefined) return matchers;
    return wrapMatchers(matchers as object, wrapper, name, false);
  };
}

function wrapMatchers(
  matchers: object,
  subject: Wrapped,
  name: string,
  negated: boolean,
): object {
  return new Proxy(matchers, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === 'symbol') return value;
      if (property === 'not' && typeof value === 'object' && value !== null) {
        return wrapMatchers(value, subject, name, !negated);
      }
      if (typeof value !== 'function' || MODIFIERS.has(property)) return value;
      const matcher = value as AnyFunction;
      return (...args: unknown[]) => {
        const stack = stackHere();
        const result = Reflect.apply(matcher, target, args);
        const done = () =>
          recordAssertion(subject, property, args, negated, {
            call: `${name}(…)${negated ? '.not' : ''}.${property}`,
            stack,
          });
        if (isThenable(result))
          return result.then((resolved) => {
            done();
            return resolved;
          });
        done();
        return result;
      };
    },
  });
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function recordAssertion(
  subject: Wrapped,
  matcher: string,
  args: readonly unknown[],
  negated: boolean,
  at: { call: string; stack: string },
): void {
  const { recorder, described } = subject;
  if (described === undefined) {
    recorder.omit(
      at.call,
      at.stack,
      'an assertion on the page has no scenario form',
    );
    return;
  }
  if ('reason' in described) {
    recorder.omit(at.call, at.stack, described.reason);
    return;
  }
  const mapped = assertionStep(matcher, described.locator, args, negated);
  if ('step' in mapped) recorder.push(mapped.step);
  else recorder.omit(at.call, at.stack, mapped.reason);
}
