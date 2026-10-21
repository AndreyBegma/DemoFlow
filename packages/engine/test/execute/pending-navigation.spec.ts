import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StepInput } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import { scenario } from './scenario.ts';

let site: { origin: string; close(): Promise<void> };
const held: ServerResponse[] = [];
const runDirs: string[] = [];

/** Keeps the main thread busy, as a slow handler on a loaded runner does. */
const BUSY =
  'function busy(ms) { const end = Date.now() + ms; while (Date.now() < end) {} }';

/**
 * #117: pages whose input handlers hold the main thread for 300 ms before the
 * navigation they cause, and pages whose clicks do not replace the document.
 */
const PAGES: Readonly<Record<string, string>> = {
  '/form': `<script>${BUSY}</script>
<form action="/results" onsubmit="busy(300)"><input name="q" aria-label="Query"></form>`,
  '/link': `<script>${BUSY}</script>
<a href="/results?q=link" onclick="busy(300)">Go</a>`,
  '/spa': `<h1 id="title">Home</h1>
<button onclick="history.pushState({}, '', '/spa/next'); document.getElementById('title').textContent = 'Next'">Next</button>`,
  '/still': '<button>Nothing</button>',
  '/hang': '<form action="/never"><input name="q" aria-label="Query"></form>',
  '/download': '<a href="/file">Get file</a>',
};

beforeAll(async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site');
    if (url.pathname === '/never') {
      held.push(response);
      return;
    }
    if (url.pathname === '/file') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="file.bin"',
      });
      response.end('data');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/results') {
      // A slow response: the commit lands well after the request starts.
      setTimeout(() => {
        response.end(`<h1>Results for ${url.searchParams.get('q') ?? ''}</h1>`);
      }, 300);
      return;
    }
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
        for (const response of held) response.destroy();
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

/** Runs the steps and returns the outcome with the page's URL at each step's end. */
async function run(
  steps: StepInput[],
): Promise<{ outcome: RunOutcome; urlAt: Map<number, string> }> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-pending-nav-'));
  runDirs.push(runDir);
  const urlAt = new Map<number, string>();
  let page: Page | undefined;
  const observer: EngineObserver = {
    onPageCreated: (event) => {
      page = event.page;
    },
    onStepFinished: ({ stepIndex }) => {
      if (page !== undefined) urlAt.set(stepIndex, page.url());
    },
  };
  const outcome = await runScenario(scenario(steps), {
    runDir,
    baseUrl: site.origin,
    allowedOrigins: [site.origin],
    env: {},
    observers: [observer],
  });
  return { outcome, urlAt };
}

function duration(outcome: RunOutcome, stepIndex: number): number {
  const event = outcome.events[stepIndex];
  if (event === undefined) throw new Error(`no event for step ${stepIndex}`);
  return event.endMs - event.startMs;
}

describe('a click or key press waits for the navigation it starts (#117)', () => {
  it('press Enter waits for a submit whose handler holds the main thread', async () => {
    const { outcome, urlAt } = await run([
      { action: 'navigate', path: '/form' },
      { action: 'fill', target: { label: 'Query' }, value: 'slow' },
      { action: 'press', key: 'Enter', target: { label: 'Query' } },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(urlAt.get(2)).toContain('/results?q=slow');
  });

  it('press without a target waits for the same submit', async () => {
    const { outcome, urlAt } = await run([
      { action: 'navigate', path: '/form' },
      { action: 'fill', target: { label: 'Query' }, value: 'kbd' },
      { action: 'press', key: 'Enter' },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(urlAt.get(2)).toContain('/results?q=kbd');
  });

  it('click waits for a link whose handler holds the main thread', async () => {
    const { outcome, urlAt } = await run([
      { action: 'navigate', path: '/link' },
      { action: 'click', target: { text: 'Go' } },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(urlAt.get(1)).toContain('/results?q=link');
  });

  it('a pushState route change and a click that changes nothing add no wait', async () => {
    const { outcome, urlAt } = await run([
      { action: 'navigate', path: '/spa' },
      { action: 'click', target: { role: 'button', name: 'Next' } },
      { action: 'navigate', path: '/still' },
      { action: 'click', target: { role: 'button', name: 'Nothing' } },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(urlAt.get(1)).toContain('/spa/next');
    // The 100 ms request window plus the glide; far below the 10 s step timeout.
    expect(duration(outcome, 1)).toBeLessThan(1_500);
    expect(duration(outcome, 3)).toBeLessThan(1_500);
  });

  it('a link that downloads a file ends the step without waiting it out', async () => {
    const { outcome, urlAt } = await run([
      { action: 'navigate', path: '/download' },
      { action: 'click', target: { text: 'Get file' }, timeoutMs: 5_000 },
    ]);
    expect(outcome.stages.execution.status).toBe('passed');
    expect(urlAt.get(1)).toContain('/download');
    expect(duration(outcome, 1)).toBeLessThan(3_000);
  });

  it('fails the step, naming the destination, when the navigation never commits', async () => {
    const { outcome } = await run([
      { action: 'navigate', path: '/hang' },
      { action: 'fill', target: { label: 'Query' }, value: 'x' },
      {
        action: 'press',
        key: 'Enter',
        target: { label: 'Query' },
        timeoutMs: 1_500,
      },
    ]);
    expect(outcome.stages.execution.status).toBe('failed');
    expect(outcome.stages.execution.error?.stepIndex).toBe(2);
    expect(outcome.stages.execution.error?.message).toContain('/never?q=x');
    expect(duration(outcome, 2)).toBeLessThan(1_500 + 2_000);
  });
});
