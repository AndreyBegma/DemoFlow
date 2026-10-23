import type { test as baseTest } from '@playwright/test';
import { type BaseExpect, wrapExpect } from './expect.ts';
import { PASS_THROUGH, recordingHelpers } from './helpers.ts';
import type { DemoflowHelpers, DemoflowTest } from './index.ts';
import { POINTER_KEY, trackPointer } from './pointer.ts';
import { activeRecorder, Recorder, setActiveRecorder } from './recorder.ts';
import { wrapPage, wrappedOf } from './wrap.ts';

// `demoflow/playwright` (spec 208, ADR-0015): `test` and `expect` that record
// each passing test as a scenario. Only types come from `@playwright/test`
// here, so the `test` and `expect` passed in are the only Playwright loaded:
// the per-minor suite passes an older version's (Decision 10).

export type BaseTest = typeof baseTest;
export type { BaseExpect } from './expect.ts';
export type { DemoflowTest } from './index.ts';

/** The fixtures `test` adds to Playwright's: `demoflow` (spec 209). */
interface DemoflowFixtures {
  demoflow: DemoflowHelpers;
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * `test` and `expect` built on `base` and `baseExpect`. Not recording, they
 * are `base` with only the no-op `demoflow` fixture added and `baseExpect`
 * itself (Decision 1).
 */
export function createTest(
  base: BaseTest,
  baseExpect: BaseExpect,
  record: boolean,
): { test: DemoflowTest; expect: BaseExpect } {
  if (!record) {
    return {
      test: base.extend<DemoflowFixtures>({ demoflow: PASS_THROUGH }),
      expect: baseExpect,
    };
  }
  const test = base.extend<DemoflowFixtures>({
    page: async ({ page }, use, testInfo) => {
      const recorder = new Recorder(testInfo, page);
      setActiveRecorder(recorder);
      // Before the first navigation, so every document tracks the pointer.
      await page.addInitScript(trackPointer, POINTER_KEY);
      try {
        await use(wrapPage(page, recorder));
      } finally {
        if (activeRecorder() === recorder) setActiveRecorder(undefined);
      }
      await recorder.finish();
    },
    demoflow: async ({ page }, use) => {
      const recorder = wrappedOf(page)?.recorder;
      await use(
        recorder === undefined ? PASS_THROUGH : recordingHelpers(recorder),
      );
    },
  });
  return { test: wrapTest(test), expect: wrapExpect(baseExpect) };
}

/** `test` whose outermost `test.step` records a scene marker first. */
function wrapTest<Test extends object>(test: Test): Test {
  return new Proxy(test, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'step') return wrapStep(value as AnyFunction);
      if (property === 'extend') {
        return (...args: unknown[]) =>
          wrapTest(Reflect.apply(value as AnyFunction, target, args) as object);
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
