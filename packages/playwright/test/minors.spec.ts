import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FixtureServer,
  startFixtureServer,
} from './harness/fixture-server.ts';
import {
  OUTPUT,
  PACKAGE,
  readTree,
  runPlaywright,
} from './harness/playwright.ts';

// Spec 208, Decision 10: the probes record the same files on the older
// supported minors of @playwright/test as on the pinned 1.64.1, whose output
// test/probes.spec.ts checks against test/expected/. Linux CI only
// (vitest.minors.config.ts); each alias needs its own Chromium.

const MINORS = ['playwright-test-1-62', 'playwright-test-1-63'];
const PROBES = [
  ['login', 'login.pw.ts', 'login-pw/sign-in'],
  ['customers', 'customers.pw.ts', 'customers-pw/create-a-customer'],
  ['tour', 'tour.pw.ts', 'tour-pw/tour'],
] as const;

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture?.close();
  await rm(OUTPUT, { recursive: true, force: true });
});

describe.each(MINORS)('%s', (playwrightPackage) => {
  it('records the same files as the pinned version', async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    const run = await runPlaywright({
      files: PROBES.map(([, file]) => file),
      record: '1',
      baseURL: fixture.origin,
      password: randomBytes(18).toString('hex'),
      playwrightPackage,
    });
    expect(run.code, run.output).toBe(0);
    const written = await readTree(OUTPUT);
    expect([...written.keys()].sort()).toEqual(
      PROBES.map(([, , at]) => `playwright/${at}.demo.json`).sort(),
    );
    for (const [name, , at] of PROBES) {
      const expected = await readFile(
        path.join(PACKAGE, 'test', 'expected', `${name}.demo.json`),
        'utf8',
      );
      expect(written.get(`playwright/${at}.demo.json`), name).toBe(
        expected.replaceAll('\r\n', '\n'),
      );
    }
  });
});
