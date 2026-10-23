import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type StepInput, TimelineSchema } from '@demoflow/core';
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

/**
 * #201: inline pages. Each annotates in its own way; the page reports what
 * the methods returned through `document.title`, and when it called through
 * `window.calledAt` (the page's `Date.now()`).
 */
const PAGES: Readonly<Record<string, string>> = {
  '/scene': `<h1>Scene</h1><script>window.demoflow?.scene('Checkout')</script>`,
  '/late': `<h1>Late</h1><script>setTimeout(() => { window.calledAt = Date.now(); window.demoflow.caption('Paying with a card') }, 500)</script>`,
  // A script in <head> runs before <body> exists.
  '/head': `<!doctype html><html><head><script>window.demoflow.scene('From head'); window.bodyAtCall = document.body === null</script></head><body><h1>Head</h1></body></html>`,
  '/opener': '<h1>Opener</h1><a href="/opened">Open</a>',
  '/opened': `<h1>Opened</h1><script>window.demoflow.caption('On the opened page')</script>`,
  '/invalid': `<h1>Invalid</h1><script>
try {
  const returned = [
    window.demoflow.scene(42),
    window.demoflow.scene(''),
    window.demoflow.caption('   '),
    window.demoflow.caption('x'.repeat(121)),
    window.demoflow.scene(),
    window.demoflow.caption({ toString: () => 'object' }),
    window.demoflow.scene(null),
    window.demoflow.scene('  padded  '),
  ];
  document.title = returned.map(String).join(',');
} catch (error) {
  document.title = 'threw ' + error;
}
</script>`,
  // The frame is not the top window: it has no `window.demoflow` (ADR-0013 §6).
  '/iframe': `<h1>Frame</h1><iframe srcdoc="<script>window.demoflow?.scene('From frame'); window.top.document.title = typeof window.demoflow</script>"></iframe>`,
  '/many': `<h1>Many</h1><script>for (let i = 0; i < 101; i++) window.demoflow.caption('n' + i)</script>`,
  '/both': `<h1>Both</h1><script>window.demoflow.scene('Both'); window.demoflow.ready('both')</script>`,
  '/quiet': '<h1>Quiet</h1>',
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
  version: unknown;
  frozen: boolean;
  bodyAtCall: unknown;
  calledAt: number | undefined;
}

/** Runs the steps; reads the page after the last one, and notes when step 0 began. */
async function run(
  steps: StepInput[],
  options: { beforeSteps?: (page: Page) => Promise<void> } = {},
): Promise<{
  outcome: RunOutcome;
  seen: Seen | undefined;
  /** The test process's clock, minus the engine's, at step 0. */
  offsetMs: number;
}> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-annotations-'));
  runDirs.push(runDir);
  let seen: Seen | undefined;
  let offsetMs = 0;
  let page: Page | undefined;
  const observer: EngineObserver = {
    onPageCreated: async (event) => {
      page = event.page;
      await options.beforeSteps?.(event.page);
    },
    onStepStarted: ({ stepIndex, startMs }) => {
      if (stepIndex === 0) offsetMs = Date.now() - startMs;
    },
    onStepFinished: async ({ stepIndex }) => {
      if (page === undefined || stepIndex !== steps.length - 1) return;
      seen = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown> & {
          demoflow?: { version: unknown };
        };
        return {
          title: document.title,
          version: w.demoflow?.version,
          frozen: w.demoflow !== undefined && Object.isFrozen(w.demoflow),
          bodyAtCall: w.bodyAtCall,
          calledAt: w.calledAt as number | undefined,
        };
      });
    },
  };
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: site.origin,
    allowedOrigins: [site.origin],
    env: {},
    observers: [observer],
  });
  return { outcome, seen, offsetMs };
}

describe('page annotations (#201)', () => {
  it('records a scene called on load', async () => {
    const { outcome } = await run([{ action: 'navigate', path: '/scene' }]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.annotations).toHaveLength(1);
    expect(outcome.annotations?.[0]).toMatchObject({
      kind: 'scene',
      title: 'Checkout',
    });
  });

  it('records a caption called 500 ms into a wait, within 100 ms of the call', async () => {
    const { outcome, seen, offsetMs } = await run([
      { action: 'navigate', path: '/late' },
      { action: 'wait', ms: 1_000 },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    const [annotation] = outcome.annotations ?? [];
    expect(annotation).toMatchObject({
      kind: 'caption',
      title: 'Paying with a card',
    });
    expect(seen?.calledAt).toBeDefined();
    if (annotation === undefined || seen?.calledAt === undefined) return;
    // The page's call time, on the engine clock.
    const callMs = seen.calledAt - offsetMs;
    expect(annotation.atMs).toBeGreaterThanOrEqual(callMs - 5);
    expect(annotation.atMs - callMs).toBeLessThan(100);
  });

  it('counts a call from a <head> script, before <body> exists', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/head' },
    ]);
    expect(seen?.bodyAtCall).toBe(true);
    expect(outcome.annotations).toMatchObject([
      { kind: 'scene', title: 'From head' },
    ]);
  });

  it('counts a call on a document a click opened', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/opener' },
      { action: 'click', target: { role: 'link', name: 'Open' } },
      { action: 'wait', ms: 100 },
    ]);
    expect(outcome.annotations).toMatchObject([
      { kind: 'caption', title: 'On the opened page' },
    ]);
  });

  it('ignores invalid calls, which return undefined and never throw', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/invalid' },
    ]);
    expect(seen?.title).toBe(Array(8).fill('undefined').join(','));
    // `{ toString }` is not a string, and the padded text is kept trimmed.
    expect(outcome.annotations).toMatchObject([
      { kind: 'scene', title: 'padded' },
    ]);
  });

  it('ignores a call from an iframe', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/iframe' },
      { action: 'wait', ms: 200 },
    ]);
    expect(seen?.title).toBe('undefined');
    expect(outcome.annotations).toBeUndefined();
  });

  it('keeps exactly the first 100 of 101 calls', async () => {
    const { outcome } = await run([{ action: 'navigate', path: '/many' }]);
    const titles = outcome.annotations?.map((entry) => entry.title);
    expect(titles).toHaveLength(100);
    expect(titles?.[0]).toBe('n0');
    expect(titles?.at(-1)).toBe('n99');
  });

  it('records a call made before step 0 starts at step 0’s start', async () => {
    const { outcome } = await run([{ action: 'navigate', path: '/quiet' }], {
      beforeSteps: async (page) => {
        await page.evaluate(() => {
          (
            window as unknown as { demoflow: { scene(t: string): void } }
          ).demoflow.scene('Early');
        });
      },
    });
    const first = outcome.events[0];
    expect(first).toBeDefined();
    expect(outcome.annotations).toEqual([
      { atMs: first?.startMs, kind: 'scene', title: 'Early' },
    ]);
  });

  it('leaves the timeline without the key when the page made no call', async () => {
    const { outcome } = await run([{ action: 'navigate', path: '/quiet' }]);
    expect('annotations' in outcome).toBe(false);
  });

  it('keeps version 1 and ready beside the new methods, and orders what it records', async () => {
    const { outcome, seen } = await run([
      { action: 'navigate', path: '/both' },
      { action: 'waitForReady', name: 'both' },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(seen).toMatchObject({ version: 1, frozen: true });
    expect(outcome.annotations).toMatchObject([{ title: 'Both' }]);
    const timeline = TimelineSchema.safeParse({
      schemaVersion: 1,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      videoFile: 'source.webm',
      events: outcome.events,
      annotations: outcome.annotations,
    });
    expect(timeline.success).toBe(true);
  });
});
