import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TimelineSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCaptureObserver,
  RUN_FILES,
  type RunOptions,
  runScenario,
} from '../../src/index.ts';
import { scenario } from './scenario.ts';

let site: { origin: string; close(): Promise<void> };
const runDirs: string[] = [];

/**
 * Plain HTML (#114): `/a` links to `/b` with a real `<a href>`, a document
 * navigation; `/spa` changes its route with `pushState`, a same-document one;
 * `/redirect` answers 302 to `/b`.
 */
const PAGES: Readonly<Record<string, string>> = {
  '/a': '<h1>Page A</h1><a href="/b">Go to B</a>',
  '/b': '<h1>Page B</h1>',
  '/to-chain': '<h1>Start</h1><a href="/chain">Go on</a>',
  // Navigates again before its own `load`: one loading stretch.
  '/chain': '<script>location.replace("/b")</script><h1>Chain</h1>',
  '/spa': `<h1 id="title">Home</h1>
<button onclick="history.pushState({}, '', '/spa/next'); document.getElementById('title').textContent = 'Next'">Next</button>`,
};

beforeAll(async () => {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://site');
    if (pathname === '/redirect') {
      response.writeHead(302, { location: '/b' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGES[pathname] ?? PAGES['/a']);
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

async function options(): Promise<RunOptions> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-navigations-'));
  runDirs.push(runDir);
  return {
    runDir,
    baseUrl: site.origin,
    allowedOrigins: [site.origin],
    env: {},
    observers: [createCaptureObserver({ scenarioId: 'inline' })],
  };
}

describe('navigations (#114)', () => {
  it('records the first load and a link click that loads a new document, one entry each', async () => {
    const opts = await options();
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/a' },
        { action: 'click', target: { role: 'link', name: 'Go to B' } },
        { action: 'assertVisible', target: { text: 'Page B' } },
      ]),
      opts,
    );
    expect(outcome.status).toBe('running');
    const navigations = outcome.navigations ?? [];
    expect(navigations).toHaveLength(2);
    const [first, click] = navigations;
    const [navigate, clickEvent] = outcome.events;
    // The first navigation is the `navigate` step itself, from about:blank.
    expect(first.startMs).toBeGreaterThanOrEqual(navigate.startMs);
    expect(first.endMs).toBeDefined();
    expect(first.endMs ?? 0).toBeLessThanOrEqual(navigate.endMs);
    // The click's navigation starts during the click and ends with the load.
    expect(click.startMs).toBeGreaterThanOrEqual(clickEvent.startMs);
    expect(click.startMs).toBeLessThanOrEqual(clickEvent.endMs);
    expect(click.endMs).toBeDefined();
    expect(click.startMs).toBeLessThan(click.endMs ?? 0);

    // Written to timeline.json, and valid there.
    const timeline = TimelineSchema.parse(
      JSON.parse(
        await readFile(path.join(opts.runDir, RUN_FILES.timeline), 'utf8'),
      ),
    );
    expect(timeline.navigations).toEqual(navigations);
  });

  it('records no navigation for a client-side route change', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/spa' },
        { action: 'click', target: { role: 'button', name: 'Next' } },
        { action: 'assertText', target: { role: 'heading' }, text: 'Next' },
      ]),
      await options(),
    );
    expect(outcome.status).toBe('running');
    // Only the `navigate` step's own load.
    expect(outcome.navigations).toHaveLength(1);
  });

  it('records a navigation that starts while another loads as one entry', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/to-chain' },
        { action: 'click', target: { role: 'link', name: 'Go on' } },
        { action: 'assertVisible', target: { text: 'Page B' } },
      ]),
      await options(),
    );
    expect(outcome.status).toBe('running');
    expect(outcome.navigations).toHaveLength(2);
  });

  it('records a redirect as one navigation', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/a' },
        { action: 'navigate', path: '/redirect' },
        { action: 'assertVisible', target: { text: 'Page B' } },
      ]),
      await options(),
    );
    expect(outcome.status).toBe('running');
    expect(outcome.navigations).toHaveLength(2);
    for (const navigation of outcome.navigations ?? []) {
      expect(navigation.startMs).toBeLessThan(navigation.endMs ?? 0);
    }
  });
});
