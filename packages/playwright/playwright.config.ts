import { tmpdir } from 'node:os';
import path from 'node:path';

// The probe suite's Playwright config (spec 208). The Vitest harness
// (test/harness/playwright.ts) spawns Playwright Test with it and passes the
// fixture's origin and the JSON report path through the environment.
//
// A plain object, not `defineConfig`: the per-minor suite runs it with an
// older @playwright/test's CLI, which must not load this one's.
const report = process.env.DEMOFLOW_PW_REPORT;

export default {
  testDir: './test/playwright',
  testMatch: '**/*.pw.ts',
  outputDir:
    process.env.DEMOFLOW_PW_OUTPUT ??
    path.join(tmpdir(), 'demoflow-playwright-results'),
  workers: 1,
  retries: 0,
  reporter:
    report === undefined
      ? [['line']]
      : [['line'], ['json', { outputFile: report }]],
  use: {
    baseURL: process.env.DEMOFLOW_PW_BASE_URL,
    viewport: { width: 1280, height: 720 },
  },
};
