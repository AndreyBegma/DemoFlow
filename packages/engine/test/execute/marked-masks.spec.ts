import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MaskedElement, MaskInterval, StepInput } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MARKED_ELEMENTS } from '../../src/execute/marked-masks.ts';
import {
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import {
  expectEndAfter,
  expectStartBy,
  inPage,
  type MarkedFrame,
  type MarkedRead,
  markedFrames,
} from './marked-frames.ts';
import { scenario } from './scenario.ts';

/** What the marked element shows: never in a message, whatever happens. */
const KEY = 'sk-live-4f9a2c71';

const STYLE =
  'position:absolute;left:40px;top:40px;margin:0;font:20px sans-serif';
const MARKED = `<p id="key" data-demoflow-mask style="${STYLE}">${KEY}</p>`;

/** A page whose script runs `after` 300 ms into its life. */
const later = (body: string, after: string): string =>
  `<!doctype html><title>later</title><body style="margin:0">${body}
<script>setTimeout(() => { ${after} }, 300)</script></body>`;

const key = "document.getElementById('key')";

/** Inline pages served at these paths, as in `mask.spec.ts`. */
const PAGES: Readonly<Record<string, string>> = {
  '/load': `<!doctype html><title>load</title><body style="margin:0">${MARKED}</body>`,
  '/later': later(
    '',
    `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(MARKED)})`,
  ),
  '/gone/remove': later(MARKED, `${key}.remove()`),
  '/gone/display': later(MARKED, `${key}.style.display = 'none'`),
  '/gone/visibility': later(MARKED, `${key}.style.visibility = 'hidden'`),
  '/gone/attribute': later(
    MARKED,
    `${key}.removeAttribute('data-demoflow-mask')`,
  ),
  '/add': later(
    `<p id="key" style="${STYLE}">${KEY}</p>`,
    `${key}.setAttribute('data-demoflow-mask', '')`,
  ),
  '/animate': `<!doctype html><title>animate</title><body style="margin:0">
<style>@keyframes slide { from { transform: translateX(0) } to { transform: translateX(600px) } }</style>
<p id="key" data-demoflow-mask style="${STYLE};animation:slide 1s linear infinite alternate">${KEY}</p>
</body>`,
  '/tall': `<!doctype html><title>tall</title><body style="margin:0">
<p id="key" data-demoflow-mask style="margin:40px;font:20px sans-serif">${KEY}</p>
<div style="height:4000px"></div><p>Bottom</p>
</body>`,
  '/leave': `<!doctype html><title>leave</title><body style="margin:0">${MARKED}
<a href="/away" style="position:absolute;left:40px;top:200px">Leave</a>
</body>`,
  '/away': '<!doctype html><title>away</title><body><p>Away</p></body>',
  '/plain':
    '<!doctype html><title>plain</title><body><p>Nothing marked</p></body>',
  '/many': `<!doctype html><title>many</title><body style="margin:0">
<script>
for (let i = 0; i < ${MAX_MARKED_ELEMENTS + 1}; i++) {
  const span = document.createElement('span');
  span.setAttribute('data-demoflow-mask', '');
  span.textContent = 'k' + i + ' ';
  document.body.append(span);
}
</script></body>`,
  '/assert': `<!doctype html><title>assert</title><body>
<div data-demoflow-mask><span data-testid="balance">${KEY}</span></div>
<p data-testid="plain">Plain text</p>
</body>`,
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
  { passes = true }: { passes?: boolean } = {},
): Promise<RunOutcome> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-marked-'));
  runDirs.push(runDir);
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
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
  if (passes) expect(outcome.stages.execution.status).toBe('passed');
  return outcome;
}

/** The run's only marked element. */
function only(outcome: RunOutcome): MaskInterval[] {
  expect(outcome.maskedElements).toHaveLength(1);
  return outcome.maskedElements?.[0]?.intervals ?? [];
}

function readOf(
  frames: ReturnType<typeof markedFrames>,
  step: number,
): MarkedRead {
  const read = frames.reads.get(step);
  expect(read, `no frames read after step ${step}`).toBeDefined();
  if (read === undefined) throw new Error('unreachable');
  return read;
}

function firstShown(drawn: readonly MarkedFrame[]): MarkedFrame {
  const frame = drawn.find(([, box]) => box !== null);
  expect(frame, 'no frame drew the element').toBeDefined();
  if (frame === undefined) throw new Error('unreachable');
  return frame;
}

function lastShown(drawn: readonly MarkedFrame[]): MarkedFrame {
  const index = drawn.findLastIndex(([, box]) => box !== null);
  expect(index, 'no frame drew the element').toBeGreaterThanOrEqual(0);
  // A frame without it follows: the element really left within the read.
  expect(drawn[index + 1]?.[1]).toBeNull();
  return drawn[index];
}

const wait = (ms: number): StepInput => ({ action: 'wait', ms });

describe('data-demoflow-mask', () => {
  it('gives an element marked from load one open interval, from before its first frame', async () => {
    const frames = markedFrames('key');
    const outcome = await run(
      [{ action: 'navigate', path: '/load' }, wait(300)],
      [frames.observer],
    );
    const intervals = only(outcome);
    expect(intervals).toHaveLength(1);
    const [interval] = intervals;
    expect(interval.endMs).toBeUndefined();
    const read = readOf(frames, 1);
    const [atMs, box] = firstShown(read.frames);
    expectStartBy(interval.startMs, atMs, read, frames.zeroMs());
    expect(interval.box).toEqual(box);
  });

  it('starts an element a timer inserts during a wait no later than its first frame', async () => {
    const frames = markedFrames('key');
    const outcome = await run(
      [{ action: 'navigate', path: '/later' }, wait(800)],
      [frames.observer],
    );
    const [interval] = only(outcome);
    const read = readOf(frames, 1);
    const [atMs] = firstShown(read.frames);
    expectStartBy(interval.startMs, atMs, read, frames.zeroMs());
    // Measured in the page, not at a step boundary: well inside the wait.
    expect(interval.startMs).toBeGreaterThan(outcome.events[1].startMs);
  });

  for (const how of ['remove', 'display', 'visibility', 'attribute']) {
    it(`ends an element that leaves (${how}) no earlier than its last frame`, async () => {
      const frames = markedFrames('key');
      const outcome = await run(
        [{ action: 'navigate', path: `/gone/${how}` }, wait(800)],
        [frames.observer],
      );
      const intervals = only(outcome);
      expect(intervals).toHaveLength(1);
      const read = readOf(frames, 1);
      const [atMs] = lastShown(read.frames);
      expectEndAfter(intervals[0].endMs, atMs, read, frames.zeroMs());
      // Measured in the page, not at the wait's end.
      expect(intervals[0].endMs).toBeLessThan(outcome.events[1].endMs);
    });
  }

  it('starts an interval when the attribute is added to an element already shown', async () => {
    const frames = markedFrames('key');
    const outcome = await run(
      [{ action: 'navigate', path: '/add' }, wait(800)],
      [frames.observer],
    );
    const [interval] = only(outcome);
    expect(interval.endMs).toBeUndefined();
    const read = readOf(frames, 1);
    const [atMs] = firstShown(read.frames);
    expectStartBy(interval.startMs, atMs, read, frames.zeroMs());
  });

  it('covers an element that moves with a transform animation on every frame', async () => {
    const frames = markedFrames('key');
    const outcome = await run(
      [{ action: 'navigate', path: '/animate' }, wait(1200)],
      [frames.observer],
    );
    const intervals = only(outcome);
    expect(intervals.length).toBeGreaterThan(10);
    const read = readOf(frames, 1);
    const zeroMs = frames.zeroMs();
    let checked = 0;
    for (const [atMs, box] of read.frames) {
      if (box === null) continue;
      const covering = intervals.filter((interval) => {
        const start = inPage(interval.startMs, read, zeroMs);
        const end =
          interval.endMs === undefined
            ? Number.POSITIVE_INFINITY
            : inPage(interval.endMs, read, zeroMs).atMs;
        return (
          start.atMs - start.uncertaintyMs <= atMs &&
          atMs <= end + start.uncertaintyMs
        );
      });
      expect(
        covering.some((interval) => contains(interval.box, box)),
        `the frame at ${atMs} ms shows the element outside every interval covering it`,
      ).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('keeps the interval open for an element scrolled out of the viewport', async () => {
    const outcome = await run([
      { action: 'navigate', path: '/tall' },
      { action: 'scroll', to: 'bottom' },
      wait(200),
    ]);
    const intervals = only(outcome);
    const last = intervals.at(-1);
    expect(last?.endMs).toBeUndefined();
    expect((last?.box.y ?? 0) + (last?.box.height ?? 0)).toBeLessThan(0);
  });

  it('ends an element on a document that navigates away no earlier than its last frame', async () => {
    const frames = markedFrames('key');
    const outcome = await run(
      [
        { action: 'navigate', path: '/leave' },
        { action: 'click', target: { role: 'link', name: 'Leave' } },
        wait(300),
      ],
      [frames.observer],
    );
    const intervals = only(outcome);
    expect(intervals).toHaveLength(1);
    // The old document's clock, read while it was on screen.
    const before = readOf(frames, 0);
    const after = readOf(frames, 2);
    expect(after.lastShownMs).not.toBeNull();
    expectEndAfter(
      intervals[0].endMs,
      after.lastShownMs ?? Number.POSITIVE_INFINITY,
      before,
      frames.zeroMs(),
    );
  });

  it('keeps an open interval open when the run fails', async () => {
    const outcome = await run(
      [
        { action: 'navigate', path: '/load' },
        wait(200),
        {
          action: 'assertVisible',
          target: { testId: 'missing' },
          timeoutMs: 300,
        },
      ],
      [],
      { passes: false },
    );
    expect(outcome.stages.verification.status).toBe('failed');
    const intervals = only(outcome);
    expect(intervals.at(-1)?.endMs).toBeUndefined();
  });

  it('writes no maskedElements when no element is marked', async () => {
    const outcome = await run([
      { action: 'navigate', path: '/plain' },
      wait(200),
    ]);
    expect('maskedElements' in outcome).toBe(false);
  });

  it('masks the whole viewport to the end past the element cap', async () => {
    const outcome = await run([
      { action: 'navigate', path: '/many' },
      wait(300),
    ]);
    const elements: MaskedElement[] = outcome.maskedElements ?? [];
    expect(elements).toHaveLength(MAX_MARKED_ELEMENTS + 1);
    const last = elements.at(-1)?.intervals;
    expect(last).toHaveLength(1);
    expect(last?.[0].box).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(last?.[0].endMs).toBeUndefined();
  });

  it('keeps a marked element’s text out of a failing assertText', async () => {
    const outcome = await run(
      [
        { action: 'navigate', path: '/assert' },
        {
          action: 'assertText',
          target: { testId: 'balance' },
          text: 'sk-test',
          timeoutMs: 300,
        },
      ],
      [],
      { passes: false },
    );
    expect(outcome.stages.verification.status).toBe('failed');
    const message = outcome.events[1].assertion?.message;
    expect(message).toBe('expected text "sk-test" in a masked element');
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('still names the text found by a failing assertText on an unmarked element', async () => {
    const outcome = await run(
      [
        { action: 'navigate', path: '/assert' },
        {
          action: 'assertText',
          target: { testId: 'plain' },
          text: 'Other',
          timeoutMs: 300,
        },
      ],
      [],
      { passes: false },
    );
    expect(outcome.events[1].assertion?.message).toContain('"Plain text"');
  });
});

/** Whether `outer` holds `inner`, give or take the 1 px a box may move before it splits. */
function contains(
  outer: MaskInterval['box'],
  inner: MaskInterval['box'],
): boolean {
  const slack = 1.01;
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}
