import {
  expect as baseExpect,
  test as baseTest,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestType,
} from '@playwright/test';
import { createTest } from './fixture.ts';

// `import { test, expect } from 'demoflow/playwright'` in place of
// `@playwright/test`. With DEMOFLOW_RECORD=1, each passing test is written as
// a scenario under demoflow/playwright/; otherwise nothing is wrapped, and
// the `demoflow` fixture's helpers do nothing.
// Read once, at import: Playwright's workers inherit the environment.
//
// The public types are declared here: the published declarations may
// reference @playwright/test only.

/** The `demoflow` test fixture (spec 209, Decision 6). */
export interface DemoflowHelpers {
  /** A caption marker at this point of the scenario: 1–120 characters. */
  caption(text: string): void;
  /** A scene marker, for a scene with no `test.step` around it. */
  scene(title: string): void;
}

/** `test` with the `demoflow` fixture. */
export type DemoflowTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & { demoflow: DemoflowHelpers },
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

const recording = createTest(
  baseTest,
  baseExpect,
  process.env.DEMOFLOW_RECORD === '1',
);

export const test: DemoflowTest = recording.test;
export const expect: typeof baseExpect = recording.expect;
