import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StepInput, TimelineEvent } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunOutcome, runScenario } from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { scenario } from './scenario.ts';

const SECRET = 'correct-horse-battery';

const FIELD = `<label for="secret">Secret</label>
<input id="secret" type="password">`;

/** Inline pages served at these paths, as in `clock-drift.spec.ts`. */
const PAGES: Readonly<Record<string, string>> = {
  '/still': `<!doctype html><title>still</title><body>
${FIELD}
<button>Nothing</button>
</body>`,
  // "Hide" removes the field; "Show" brings it back 200 px lower.
  '/toggle': `<!doctype html><title>toggle</title><body style="margin:0">
<div id="form" style="position:absolute;left:40px;top:40px">${FIELD}</div>
<button style="position:fixed;left:40px;top:400px" onclick="
  document.getElementById('form').hidden = true">Hide</button>
<button style="position:fixed;left:140px;top:400px" onclick="
  const form = document.getElementById('form');
  form.style.top = '240px';
  form.hidden = false">Show</button>
</body>`,
  '/tall': `<!doctype html><title>tall</title><body style="margin:0">
<div style="padding:40px">${FIELD}</div>
<div style="height:4000px"></div>
<p>Bottom</p>
</body>`,
  // The same field on two pages, at different places.
  '/first': `<!doctype html><title>first</title><body style="margin:0">
<div style="position:absolute;left:40px;top:40px">${FIELD}</div>
</body>`,
  '/second': `<!doctype html><title>second</title><body style="margin:0">
<div style="position:absolute;left:40px;top:300px">${FIELD}</div>
</body>`,
};

const fillSecret: StepInput = {
  action: 'fill',
  target: { label: 'Secret' },
  valueFrom: { env: 'SECRET' },
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

async function run(steps: StepInput[]): Promise<RunOutcome> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-mask-'));
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
    ],
  });
  expect(outcome.stages.execution.status).toBe('passed');
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  return outcome;
}

function intervalsOf(event: TimelineEvent) {
  expect(event.masked).toBe(true);
  expect(event.maskVisibility).toBeDefined();
  return event.maskVisibility ?? [];
}

describe('mask visibility', () => {
  it('keeps one open interval for a field that stays to the end', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/still' },
      fillSecret,
      { action: 'click', target: { role: 'button', name: 'Nothing' } },
      { action: 'wait', ms: 200 },
    ]);
    const fill = events[1];
    expect(intervalsOf(fill)).toEqual([
      { startMs: fill.startMs, box: fill.target?.box },
    ]);
  });

  it('opens a second interval, with its own box, when the field comes back', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/toggle' },
      fillSecret,
      { action: 'click', target: { role: 'button', name: 'Hide' } },
      { action: 'wait', ms: 200 },
      { action: 'click', target: { role: 'button', name: 'Show' } },
      { action: 'wait', ms: 200 },
    ]);
    const [fill, hide, show] = [events[1], events[2], events[4]];
    const intervals = intervalsOf(fill);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({
      startMs: fill.startMs,
      endMs: hide.endMs,
      box: fill.target?.box,
    });
    expect(intervals[1].startMs).toBe(show.startMs);
    expect(intervals[1].endMs).toBeUndefined();
    expect(intervals[1].box.y - intervals[0].box.y).toBeCloseTo(200, 0);
  });

  it('keeps the interval open while the field is scrolled out of the viewport', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/tall' },
      fillSecret,
      { action: 'scroll', to: 'bottom' },
      { action: 'wait', ms: 200 },
    ]);
    const [fill, scroll] = [events[1], events[2]];
    const box = fill.target?.box;
    // The page really scrolled the field past the top edge.
    expect(scroll.scroll?.after.y).toBeGreaterThan(
      (box?.y ?? 0) + (box?.height ?? 0),
    );
    expect(intervalsOf(fill)).toEqual([{ startMs: fill.startMs, box }]);
  });

  it('overlaps the old and new box for a navigation that keeps the field on screen', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/first' },
      fillSecret,
      { action: 'navigate', path: '/second' },
      { action: 'wait', ms: 200 },
    ]);
    const [fill, navigate] = [events[1], events[2]];
    const intervals = intervalsOf(fill);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({
      startMs: fill.startMs,
      endMs: navigate.endMs,
      box: fill.target?.box,
    });
    expect(intervals[1].startMs).toBe(navigate.startMs);
    expect(intervals[1].endMs).toBeUndefined();
    expect(intervals[1].box.y - intervals[0].box.y).toBeCloseTo(260, 0);
  });
});
