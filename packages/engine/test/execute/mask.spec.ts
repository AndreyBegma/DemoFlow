import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StepInput, TimelineEvent } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { pageFrames } from './page-frames.ts';
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
  // "Hide" and "Show" flip the form's `display`, the field stays in the DOM.
  '/display': `<!doctype html><title>display</title><body style="margin:0">
<div id="form" style="position:absolute;left:40px;top:40px">${FIELD}</div>
<button style="position:fixed;left:40px;top:400px" onclick="
  document.getElementById('form').style.display = 'none'">Hide</button>
<button style="position:fixed;left:140px;top:400px" onclick="
  document.getElementById('form').style.display = ''">Show</button>
</body>`,
  // A link to a document without the field.
  '/leave': `<!doctype html><title>leave</title><body style="margin:0">
${FIELD}
<a href="/away">Leave</a>
</body>`,
  '/away': `<!doctype html><title>away</title><body><p>Away</p></body>`,
  // "Swap" puts a new field in the old one's place and removes it 30 ms later:
  // the old field's edge is not where the secret left the screen.
  '/swap': `<!doctype html><title>swap</title><body style="margin:0">
<div id="form">${FIELD}</div>
<button onclick="
  const old = document.getElementById('secret');
  const next = document.createElement('input');
  next.type = 'password';
  next.value = old.value;
  old.replaceWith(next);
  next.id = 'secret';
  setTimeout(() => next.remove(), 30)">Swap</button>
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

async function run(
  steps: StepInput[],
  observers: readonly EngineObserver[] = [],
): Promise<RunOutcome> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-mask-'));
  runDirs.push(runDir);
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
    env: { SECRET },
    observers: [
      ...observers,
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

/**
 * An end the page saw (#155), by the page's own frames (#173): mapped into
 * page time, not before the first frame drawn without the field, and before
 * the frame after it — each widened by the clock exchange's uncertainty, the
 * only tolerance. A wall-clock margin after the click does not hold on a
 * runner that skips frames for 100 ms. Also before the click step's own end,
 * and never before the click began.
 */
function expectPreciseEnd(
  endMs: number | undefined,
  click: TimelineEvent,
  frames: ReturnType<typeof pageFrames>,
): void {
  expect(endMs).toBeDefined();
  expect(endMs).toBeLessThan(click.endMs);
  expect(endMs).toBeGreaterThan(click.startMs);
  const read = frames.reads.get(click.stepIndex);
  expect(read).toBeDefined();
  if (endMs === undefined || read === undefined) return;
  // The last time the field left the screen by the click step's end.
  const drawn = read.frames;
  const hidden = drawn.findLastIndex(
    ([, shown], i) => !shown && i > 0 && drawn[i - 1][1],
  );
  expect(hidden).toBeGreaterThan(0);
  expect(hidden).toBeLessThan(drawn.length - 1);
  const { minMs, maxMs } = read.shift;
  const uncertaintyMs = maxMs - minMs;
  const pageEndMs = endMs + frames.zeroMs() - maxMs;
  expect(pageEndMs).toBeGreaterThanOrEqual(drawn[hidden][0] - uncertaintyMs);
  expect(pageEndMs).toBeLessThan(drawn[hidden + 1][0] + uncertaintyMs);
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
    const frames = pageFrames('secret');
    const { events } = await run(
      [
        { action: 'navigate', path: '/toggle' },
        fillSecret,
        { action: 'click', target: { role: 'button', name: 'Hide' } },
        { action: 'wait', ms: 200 },
        { action: 'click', target: { role: 'button', name: 'Show' } },
        { action: 'wait', ms: 200 },
      ],
      [frames.observer],
    );
    const [fill, hide, show] = [events[1], events[2], events[4]];
    const intervals = intervalsOf(fill);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({
      startMs: fill.startMs,
      box: fill.target?.box,
    });
    expectPreciseEnd(intervals[0].endMs, hide, frames);
    expect(intervals[1].startMs).toBe(show.startMs);
    expect(intervals[1].endMs).toBeUndefined();
    expect(intervals[1].box.y - intervals[0].box.y).toBeCloseTo(200, 0);
  });

  it('ends both intervals where the page hid the field: display none, shown, hidden again', async () => {
    const frames = pageFrames('secret');
    const { events } = await run(
      [
        { action: 'navigate', path: '/display' },
        fillSecret,
        { action: 'click', target: { role: 'button', name: 'Hide' } },
        { action: 'wait', ms: 200 },
        { action: 'click', target: { role: 'button', name: 'Show' } },
        { action: 'wait', ms: 200 },
        { action: 'click', target: { role: 'button', name: 'Hide' } },
        { action: 'wait', ms: 200 },
      ],
      [frames.observer],
    );
    const [fill, hide, show, hideAgain] = [
      events[1],
      events[2],
      events[4],
      events[6],
    ];
    const intervals = intervalsOf(fill);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({
      startMs: fill.startMs,
      box: fill.target?.box,
    });
    expectPreciseEnd(intervals[0].endMs, hide, frames);
    // A field that comes back starts as before: at the step that found it (#155, Decision 3).
    expect(intervals[1]).toMatchObject({
      startMs: show.startMs,
      box: fill.target?.box,
    });
    expectPreciseEnd(intervals[1].endMs, hideAgain, frames);
  });

  it('ends at the step boundary when the page that held the field is replaced', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/leave' },
      fillSecret,
      { action: 'click', target: { role: 'link', name: 'Leave' } },
      { action: 'wait', ms: 200 },
    ]);
    const [fill, leave] = [events[1], events[2]];
    expect(intervalsOf(fill)).toEqual([
      { startMs: fill.startMs, endMs: leave.endMs, box: fill.target?.box },
    ]);
  });

  it('ends at the step boundary when another field stood in for it and left', async () => {
    const { events } = await run([
      { action: 'navigate', path: '/swap' },
      fillSecret,
      { action: 'click', target: { role: 'button', name: 'Swap' } },
      { action: 'wait', ms: 200 },
    ]);
    const [fill, swap] = [events[1], events[2]];
    expect(intervalsOf(fill)).toEqual([
      { startMs: fill.startMs, endMs: swap.endMs, box: fill.target?.box },
    ]);
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
