import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type StepInput, TimelineEventSchema } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { scenario } from './scenario.ts';

let site: { origin: string; close(): Promise<void> };
const runDirs: string[] = [];

/** Records when the page signalled, in the page's `Date.now()`. */
const STAMP = 'window.signalledAt = Date.now();';

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
}

/** Runs the steps; reads the page after each step, and notes when each step began. */
async function run(steps: StepInput[]): Promise<{
  outcome: RunOutcome;
  seen: Map<number, Seen>;
  /** The test process's clock when each step began. */
  began: Map<number, { nowMs: number; startMs: number }>;
}> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-ready-'));
  runDirs.push(runDir);
  const seen = new Map<number, Seen>();
  const began = new Map<number, { nowMs: number; startMs: number }>();
  let page: Page | undefined;
  const observer: EngineObserver = {
    onPageCreated: (event) => {
      page = event.page;
    },
    onStepStarted: ({ stepIndex, startMs }) => {
      began.set(stepIndex, { nowMs: Date.now(), startMs });
    },
    onStepFinished: async ({ stepIndex }) => {
      if (page === undefined) return;
      seen.set(
        stepIndex,
        await page.evaluate(() => {
          const w = window as unknown as Record<string, unknown> & {
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
          };
        }),
      );
    },
  };
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: site.origin,
    allowedOrigins: [site.origin],
    env: {},
    observers: [observer],
  });
  return { outcome, seen, began };
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

  it('passes within 100 ms of a signal sent 500 ms into the step', async () => {
    const { outcome, seen, began } = await run([
      { action: 'navigate', path: '/late' },
      { action: 'waitForReady', name: 'late' },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    const step = event(outcome, 1);
    const signalledAt = seen.get(1)?.signalledAt;
    const start = began.get(1);
    expect(signalledAt).toBeDefined();
    if (signalledAt === undefined || start === undefined) return;
    // The page's signal time, on the engine clock.
    const signalMs = signalledAt - (start.nowMs - start.startMs);
    expect(step.endMs).toBeGreaterThanOrEqual(signalMs - 5);
    expect(step.endMs - signalMs).toBeLessThan(100);
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
