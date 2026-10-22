import { expect as baseExpect, test as baseTest } from '@playwright/test';
import { createTest } from './fixture.ts';

// `import { test, expect } from 'demoflow/playwright'` in place of
// `@playwright/test`. With DEMOFLOW_RECORD=1, each passing test is written as
// a scenario under demoflow/playwright/; otherwise nothing is wrapped.
// Read once, at import: Playwright's workers inherit the environment.

const recording = createTest(
  baseTest,
  baseExpect,
  process.env.DEMOFLOW_RECORD === '1',
);

export const test: typeof baseTest = recording.test;
export const expect: typeof baseExpect = recording.expect;
