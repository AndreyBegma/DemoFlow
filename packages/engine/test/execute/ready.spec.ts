import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { type StepInput, TimelineEventSchema } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { clockShift } from './page-frames.ts';
import { scenario } from './scenario.ts';

let site: { origin: string; close(): Promise<void> };
const runDirs: string[] = [];

/** Records when the page signalled, in the page's `performance.now()`. */
const STAMP = 'window.signalledAt = performance.now();';

/** The page global (a registered symbol) the poll probe records on. */
const POLLS_KEY = 'demoflow.test.polls';

/** The engine's poll interval (`POLL_MS` in `src/execute/ready.ts`). */
const POLL_MS = 50;

/** One look at the ready set for the watched name, in page time: when, and whether it was there. */
type Poll = readonly [atMs: number, ready: boolean];

/** What the poll probe recorded, in page time. */
interface PollRecord {
  polls: Poll[];
  /** A `setTimeout(POLL_MS)` chain of the page's own: how late this page fires such a timer. */
  ticks: number[];
}

/**
 * #198: inline pages. Each signals (or not) in its own way; the page reports
 * back through `document.title` or a global the test reads.
 */
const PAGES: Readonly<Record<string, string>> = {
  '/load': `<h1>Load</h1><script>${STAMP} window.demoflow?.ready('loaded')</script>`,
  '/late': `<h1>Late</h1><script>setTimeout(() => { ${STAMP} window.demoflow.ready('late') }, 500)</script>`,
  '/silent': '<h1>Silent</h1>',
  // A script in <head> runs before <body> exists.
  '/head': `<!doctype html><html><head><script>window.demoflow.ready('from-head'); window.bodyAtSignal = document.body === null</script></head><body><h1>Head</h1></body></html>`,
  '/first': `<h1>First</h1><script>window.demoflow.ready('first-only')</script><a href="/second">Next</a>`,
  '/second': '<h1>Second</h1>',
  '/spa': `<h1>Spa</h1><script>window.demoflow.ready('spa-ready')</script>
<button onclick="history.pushState({}, '', '/spa/next')">Push</button>`,
  '/invalid': `<h1>Invalid</h1><script>
try {
  window.demoflow.ready(42);
  window.demoflow.ready('bad name!');
  window.demoflow.ready(['abc']);
  window.demoflow.ready();
  window.demoflow.ready({ toString: () => 'abc' });
  window.demoflow.ready(null);
  window.demoflow.ready('x'.repeat(65));
  window.demoflow.ready('good');
  document.title = 'ok';
} catch (error) {
  document.title = 'threw ' + error;
}
</script>`,
  '/opener': '<h1>Opener</h1><a href="/opened">Open</a>',
  '/opened': '<h1>Opened</h1>',
};

beforeAll(async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGES[url.pathname] ?? '<h1>Not here</h1>');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  site = {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
});

afterAll(async () => {
  await site.close();
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Seen {
  title: string;
  demoflow: { version: unknown; frozen: boolean } | undefined;
  bodyAtSignal: unknown;
  signalledAt: number | undefined;
  /** The watched name's polls and the page's reference ticks so far; empty unless the run watches one. */
  record: PollRecord;
  /** The test process's clock minus the page's, when `watch` is set. */
  shift: { minMs: number; maxMs: number } | undefined;
}

/**
 * Runs the steps; reads the page after each step. With `watch`, also records
 * every poll of the ready set for that name and takes a clock exchange after
 * each step, to place the engine's times in page time (as `page-frames.ts`
 * does for #173).
 */
async function run(
  steps: StepInput[],
  watch?: string,
): Promise<{
  outcome: RunOutcome;
  seen: Map<number, Seen>;
  /** The test process's clock at engine zero, at the latest. */
  zeroMs: number;
}> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-ready-'));
  runDirs.push(runDir);
  const seen = new Map<number, Seen>();
  let zeroMs = Number.POSITIVE_INFINITY;
  let page: Page | undefined;
  const observer: EngineObserver = {
    onPageCreated: async (event) => {
      // The engine's clock starts before the page is announced.
      zeroMs = performance.now();
      page = event.page;
      if (watch !== undefined) {
        await page.addInitScript(pollProbe, {
          key: POLLS_KEY,
          name: watch,
          intervalMs: POLL_MS,
        });
      }
    },
    onStepStarted: ({ startMs }) => {
      zeroMs = Math.min(zeroMs, performance.now() - startMs);
    },
    onStepFinished: async ({ stepIndex }) => {
      if (page === undefined) return;
      const read = await page.evaluate((key) => {
        const w = window as unknown as Record<string, unknown> &
          Record<symbol, PollRecord | undefined> & {
            demoflow?: { version: unknown };
          };
        return {
          title: document.title,
          demoflow:
            w.demoflow === undefined
              ? undefined
              : {
                  version: w.demoflow.version,
                  frozen: Object.isFrozen(w.demoflow),
                },
          bodyAtSignal: w.bodyAtSignal,
          signalledAt: w.signalledAt as number | undefined,
          record: {
            polls: [...(w[Symbol.for(key)]?.polls ?? [])],
            ticks: [...(w[Symbol.for(key)]?.ticks ?? [])],
          },
        };
      }, POLLS_KEY);
      const shift = watch === undefined ? undefined : await clockShift(page);
      seen.set(stepIndex, { ...read, shift });
    },
  };
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: site.origin,
    allowedOrigins: [site.origin],
    env: {},
    observers: [observer],
  });
  return { outcome, seen, zeroMs };
}

/**
 * Runs in every document, after the engine's ready script: records each look
 * at a set for `name` — the engine's poll reads the ready set with `has` —
 * and runs a `setTimeout(intervalMs)` chain of its own, the reference for
 * how late this page fires a timer of the engine's interval.
 */
function pollProbe(input: {
  key: string;
  name: string;
  intervalMs: number;
}): void {
  const record = {
    polls: [] as Array<[number, boolean]>,
    ticks: [] as number[],
  };
  Object.defineProperty(window, Symbol.for(input.key), { value: record });
  const has = Set.prototype.has;
  Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
    const ready = has.call(this, value);
    if (value === input.name) {
      record.polls.push([window.performance.now(), ready]);
    }
    return ready;
  };
  const tick = (): void => {
    record.ticks.push(window.performance.now());
    setTimeout(tick, input.intervalMs);
  };
  tick();
}

/**
 * The longest gap of the page's reference chain from `fromMs` through the
 * first tick after `toMs`: the page's own interval, as late as it ran then.
 */
function referenceGapMs(ticks: number[], fromMs: number, toMs: number): number {
  const after = ticks.findIndex((atMs) => atMs > toMs);
  const last = after === -1 ? ticks.length - 1 : after;
  let gapMs = 0;
  for (let i = 1; i <= last; i++) {
    if (ticks[i] >= fromMs) gapMs = Math.max(gapMs, ticks[i] - ticks[i - 1]);
  }
  return gapMs;
}

function event(outcome: RunOutcome, stepIndex: number) {
  const found = outcome.events[stepIndex];
  if (found === undefined) throw new Error(`no event for step ${stepIndex}`);
  return found;
}

describe('waitForReady (#198)', () => {
  it('passes at once for a signal sent on load', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/load' },
      { action: 'waitForReady', name: 'loaded' },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    const step = event(outcome, 1);
    expect(step.endMs - step.startMs).toBeLessThan(200);
  });

  // #218: what the wait guarantees, on the page's clock — it ends after the
  // signal, passes on the first poll after it, and that poll comes within the
  // page's own timer interval. A wall-clock margin after the signal measures
  // how late a loaded runner fires the page's timers, not the engine: a macOS
  // runner recording video stretched it to 164 ms.
  it('passes on the first poll after a signal sent 500 ms into the step', async () => {
    const { outcome, seen, zeroMs } = await run(
      [
        { action: 'navigate', path: '/late' },
        { action: 'waitForReady', name: 'late' },
      ],
      'late',
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const step = event(outcome, 1);
    const read = seen.get(1);
    expect(read?.signalledAt).toBeDefined();
    expect(read?.shift).toBeDefined();
    if (read?.signalledAt === undefined || read.shift === undefined) return;
    const signalledAt = read.signalledAt;
    const { polls, ticks } = read.record;
    const misses = polls.filter(([, ready]) => !ready);
    const hits = polls.filter(([, ready]) => ready);
    // It polled while the page was silent, and none of those looks came after the signal.
    expect(misses.length).toBeGreaterThan(1);
    for (const [atMs] of misses) expect(atMs).toBeLessThanOrEqual(signalledAt);
    // The next look found the name, and the wait stopped there.
    expect(hits).toHaveLength(1);
    const [seenAt] = hits[0];
    expect(seenAt).toBeGreaterThanOrEqual(signalledAt);
    // That look came within the poll interval as this page kept time then:
    // two of its own reference gaps, so a poll slower than the engine's is caught.
    const gapMs = referenceGapMs(ticks, misses[0][0], seenAt);
    expect(gapMs).toBeGreaterThanOrEqual(POLL_MS - 1);
    expect(seenAt - signalledAt).toBeLessThanOrEqual(2 * gapMs);
    // The step's end, in page time: after the signal and the look that saw it,
    // each widened by the clock exchange's uncertainty, the only tolerance.
    const { minMs, maxMs } = read.shift;
    const uncertaintyMs = maxMs - minMs;
    const pageEndMs = step.endMs + zeroMs - maxMs;
    expect(pageEndMs).toBeGreaterThanOrEqual(seenAt - uncertaintyMs);
  });

  it('fails with ready-timeout at timeoutMs when nothing signals', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/silent' },
      { action: 'waitForReady', name: 'never', timeoutMs: 400 },
      { action: 'wait', ms: 1 },
    ]);
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 1, message: 'ready-timeout never' },
    });
    expect(outcome.events).toHaveLength(2);
    const step = event(outcome, 1);
    expect(step.error?.message).toBe('ready-timeout never');
    expect(step.endMs - step.startMs).toBeGreaterThanOrEqual(380);
    expect(step.endMs - step.startMs).toBeLessThan(1_500);
  });

  it('does not count a signal from the previous document', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/first' },
      { action: 'waitForReady', name: 'first-only' },
      { action: 'click', target: { role: 'link', name: 'Next' } },
      { action: 'waitForReady', name: 'first-only', timeoutMs: 400 },
    ]);
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 3, message: 'ready-timeout first-only' },
    });
    expect(event(outcome, 1).error).toBeUndefined();
  });

  it('keeps a signal across a same-document pushState, and across waits', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/spa' },
      { action: 'waitForReady', name: 'spa-ready' },
      { action: 'click', target: { role: 'button', name: 'Push' } },
      { action: 'waitForReady', name: 'spa-ready', timeoutMs: 400 },
      { action: 'waitForReady', name: 'spa-ready', timeoutMs: 400 },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
  });

  it('ignores a non-string argument and a malformed name without throwing', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/invalid' },
      { action: 'waitForReady', name: 'good' },
      // `['abc']` and an object that prints as `abc` are not strings.
      { action: 'waitForReady', name: 'abc', timeoutMs: 400 },
    ]);
    expect(seen.get(0)?.title).toBe('ok');
    expect(event(outcome, 1).error).toBeUndefined();
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 2, message: 'ready-timeout abc' },
    });
  });

  it('counts a valid call from a <head> script, before <body> exists', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/head' },
      { action: 'waitForReady', name: 'from-head' },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(seen.get(1)?.bodyAtSignal).toBe(true);
  });

  it('defines a frozen window.demoflow, version 1, on every document', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/opener' },
      { action: 'click', target: { role: 'link', name: 'Open' } },
      { action: 'wait', ms: 1 },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    const frozen = { version: 1, frozen: true };
    expect(seen.get(0)?.demoflow).toEqual(frozen);
    expect(seen.get(2)?.demoflow).toEqual(frozen);
  });

  it('records a plain step event: its times and no target', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/load' },
      { action: 'waitForReady', name: 'loaded', caption: 'Loaded' },
    ]);
    const step = event(outcome, 1);
    expect(step).toMatchObject({ action: 'waitForReady', caption: 'Loaded' });
    expect(step.target).toBeUndefined();
    expect(step.endMs).toBeGreaterThanOrEqual(step.startMs);
    expect(TimelineEventSchema.safeParse(step).success).toBe(true);
  });
});
