import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StepInput } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCaptureObserver,
  RUN_FILES,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { scenario } from './scenario.ts';

const SECRET = 'xK9#partial-secret';
/** Typing stops being answered once this many characters are in the field. */
const TYPED = 4;

const LABEL = '<label for="secret">Secret</label>';

/** Inline pages served at these paths, as in `mask.spec.ts`. */
const PAGES: Readonly<Record<string, string>> = {
  // Mirrors the value into the attribute, as a React-controlled input does,
  // then blocks the main thread so the rest of the typing times out.
  '/stall': `<!doctype html><title>stall</title><body>${LABEL}
<input id="secret" type="password" oninput="
  this.setAttribute('value', this.value);
  if (this.value.length === ${TYPED}) {
    const until = Date.now() + 3000;
    while (Date.now() < until);
  }">
</body>`,
  // The field leaves the page part-way through the typing.
  '/detach': `<!doctype html><title>detach</title><body>${LABEL}
<input id="secret" type="password" oninput="
  if (this.value.length === ${TYPED}) this.remove()">
</body>`,
  '/empty': `<!doctype html><title>empty</title><body><p>No field</p></body>`,
};

const fillSecret: StepInput = {
  action: 'fill',
  target: { label: 'Secret' },
  valueFrom: { env: 'SECRET' },
  timeoutMs: 300,
};

let fixture: FixtureServer;
const runDirs: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.close();
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Run {
  outcome: RunOutcome;
  /** `timeline.json` and `result.json`, as written. */
  files: string;
}

async function run(steps: StepInput[]): Promise<Run> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-masked-fill-'));
  runDirs.push(runDir);
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
    env: { SECRET },
    observers: [
      {
        onPageCreated: async ({ page }) => {
          for (const [pathname, body] of Object.entries(PAGES)) {
            await page.route(`${fixture.origin}${pathname}`, (route) =>
              route.fulfill({ contentType: 'text/html', body }),
            );
          }
        },
      },
      createCaptureObserver({ scenarioId: 'inline' }),
    ],
  });
  const files = await Promise.all(
    [RUN_FILES.timeline, RUN_FILES.result].map((file) =>
      readFile(path.join(runDir, file), 'utf8'),
    ),
  );
  return { outcome, files: files.join('\n') };
}

/** Every prefix of the secret long enough to mean something. */
function expectNoPartialSecret(text: string): void {
  for (let length = TYPED; length <= SECRET.length; length++) {
    expect(text).not.toContain(SECRET.slice(0, length));
  }
}

describe('a masked fill that fails', () => {
  it('stays masked, with its box and an open interval, when typing times out part-way', async () => {
    const { outcome, files } = await run([
      { action: 'navigate', path: '/stall' },
      fillSecret,
    ]);
    expect(outcome.stages.execution.status).toBe('failed');
    const fill = outcome.events[1];
    expect(fill.error).toBeDefined();
    expect(fill.masked).toBe(true);
    expect(fill.value).toBe('***');
    const box = fill.target?.box;
    expect(box).toBeDefined();
    expect(fill.maskVisibility).toEqual([{ startMs: fill.startMs, box }]);
    // Playwright's call log prints the element, attributes and all; only its first line is kept.
    expect(fill.error?.message).toMatch(
      /^locator\.pressSequentially: Timeout \d+ms exceeded\.$/,
    );
    expectNoPartialSecret(fill.error?.message ?? '');
    expectNoPartialSecret(JSON.stringify(outcome));
    expectNoPartialSecret(files);
  });

  it('is masked with no box when its field never appears', async () => {
    const { outcome, files } = await run([
      { action: 'navigate', path: '/empty' },
      fillSecret,
    ]);
    expect(outcome.stages.execution.status).toBe('failed');
    const fill = outcome.events[1];
    expect(fill.error).toBeDefined();
    expect(fill.masked).toBe(true);
    expect(fill.value).toBe('***');
    expect(fill.target).toBeUndefined();
    expect(fill.maskVisibility).toBeUndefined();
    expectNoPartialSecret(files);
  });
});

describe('a masked fill whose field is removed during typing', () => {
  // Playwright sends the rest of the keys to the page and the step passes.
  it('is masked from the fill on', async () => {
    const { outcome, files } = await run([
      { action: 'navigate', path: '/detach' },
      fillSecret,
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    const fill = outcome.events[1];
    expect(fill.masked).toBe(true);
    const box = fill.target?.box;
    expect(box).toBeDefined();
    expect(fill.maskVisibility?.[0]).toMatchObject({
      startMs: fill.startMs,
      box,
    });
    expectNoPartialSecret(files);
  });
});
