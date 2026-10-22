import type { test as baseTest } from '@playwright/test';
import { type BaseExpect, wrapExpect } from './expect.ts';
import { activeRecorder, Recorder, setActiveRecorder } from './recorder.ts';
import { wrapPage } from './wrap.ts';

// `demoflow/playwright` (spec 208, ADR-0015): `test` and `expect` that record
// each passing test as a scenario. Only types come from `@playwright/test`
// here, so the `test` and `expect` passed in are the only Playwright loaded:
// the per-minor suite passes an older version's (Decision 10).

export type BaseTest = typeof baseTest;
export type { BaseExpect } from './expect.ts';

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * `test` and `expect` built on `base` and `baseExpect`. Not recording, they
 * are `base` with no fixture overridden and `baseExpect` itself (Decision 1).
 */
export function createTest(
  base: BaseTest,
  baseExpect: BaseExpect,
  record: boolean,
): { test: BaseTest; expect: BaseExpect } {
  if (!record) return { test: base.extend({}), expect: baseExpect };
  const test = base.extend({
    page: async ({ page }, use, testInfo) => {
      const recorder = new Recorder(testInfo, page);
      setActiveRecorder(recorder);
      try {
        await use(wrapPage(page, recorder));
      } finally {
        if (activeRecorder() === recorder) setActiveRecorder(undefined);
      }
      await recorder.finish();
    },
  });
  return { test: wrapTest(test), expect: wrapExpect(baseExpect) };
}

/** `test` whose outermost `test.step` records a scene marker first. */
function wrapTest(test: BaseTest): BaseTest {
  return new Proxy(test, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'step') return wrapStep(value as AnyFunction);
      if (property === 'extend') {
        return (...args: unknown[]) =>
          wrapTest(
            Reflect.apply(value as AnyFunction, target, args) as BaseTest,
          );
      }
      return value;
    },
  });
}

function wrapStep(step: AnyFunction): AnyFunction {
  return new Proxy(step, {
    apply(target, self, args: unknown[]) {
      const recorder = activeRecorder();
      const [title, body, ...rest] = args;
      if (recorder === undefined || typeof body !== 'function') {
        return Reflect.apply(target, self, args);
      }
      if (recorder.stepDepth === 0 && typeof title === 'string') {
        recorder.push({ action: 'marker', title, kind: 'scene' });
      }
      const counted = async (...bodyArgs: unknown[]) => {
        recorder.stepDepth += 1;
        try {
          return await Reflect.apply(body as AnyFunction, undefined, bodyArgs);
        } finally {
          recorder.stepDepth -= 1;
        }
      };
      return Reflect.apply(target, self, [title, counted, ...rest]);
    },
  });
}
