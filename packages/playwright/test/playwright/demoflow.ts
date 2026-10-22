import type { BaseExpect, BaseTest } from '../../src/fixture.ts';

// What the probes import in place of `demoflow/playwright`. By default it is
// that entry itself (src/index.ts). The per-minor suite (spec 208, Decision
// 10) names an aliased @playwright/test in DEMOFLOW_PLAYWRIGHT_PACKAGE, and
// the probes get `createTest` over that version's `test` and `expect`.

const aliased = process.env.DEMOFLOW_PLAYWRIGHT_PACKAGE;

async function load(): Promise<{ test: BaseTest; expect: BaseExpect }> {
  if (aliased === undefined) return import('../../src/index.ts');
  const { createTest } = await import('../../src/fixture.ts');
  const playwright = (await import(aliased)) as {
    test: BaseTest;
    expect: BaseExpect;
  };
  return createTest(
    playwright.test,
    playwright.expect,
    process.env.DEMOFLOW_RECORD === '1',
  );
}

export const { test, expect } = await load();
export type { Page } from '@playwright/test';
