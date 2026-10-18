import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOptions,
  runScenario,
} from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { scenario } from './scenario.ts';

let fixture: FixtureServer;
let forms: { origin: string; close(): Promise<void> };
const runDirs: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer();
  // A plain form whose submit navigates: GET /form → GET /results?q=…
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://forms');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/results') {
      response.end(
        `<h1>Results for ${url.searchParams.get('q') ?? ''}</h1><p>done</p>`,
      );
      return;
    }
    response.end(
      '<form action="/results"><input name="q" aria-label="Query"></form>',
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  forms = {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
});

afterAll(async () => {
  await fixture.close();
  await forms.close();
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function options(
  origin: string,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-press-'));
  runDirs.push(runDir);
  return {
    runDir,
    baseUrl: origin,
    allowedOrigins: [origin],
    env: {},
    ...extra,
  };
}

describe('press', () => {
  it('types into the customers search and presses Enter on it', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/customers' },
        {
          action: 'fill',
          target: { label: 'Search customers' },
          value: 'Ada',
        },
        {
          action: 'press',
          key: 'Enter',
          target: { label: 'Search customers' },
        },
        { action: 'assertText', target: { css: 'tbody' }, text: 'Ada' },
      ]),
      await options(fixture.origin),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.verification.status).toBe('passed');
    const event = outcome.events[2];
    expect(event).toMatchObject({
      stepIndex: 2,
      action: 'press',
      key: 'Enter',
    });
    expect(event?.target?.box.width).toBeGreaterThan(0);
    expect(event?.pointer).toBeDefined();
  });

  it('sends the key to the focused element when there is no target', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/form' },
        { action: 'fill', target: { label: 'Query' }, value: 'kbd' },
        { action: 'press', key: 'Enter' },
        {
          action: 'assertText',
          target: { css: 'h1' },
          text: 'Results for kbd',
        },
      ]),
      await options(forms.origin),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.verification.status).toBe('passed');
    const event = outcome.events[2];
    expect(event).toMatchObject({ action: 'press', key: 'Enter' });
    expect(event?.target).toBeUndefined();
    expect(event?.pointer).toBeUndefined();
  });

  it('waits for the navigation a submit starts, as a click does', async () => {
    const urlAtStepEnd = new Map<number, string>();
    let page: Page | undefined;
    const observer: EngineObserver = {
      onPageCreated: (event) => {
        page = event.page;
      },
      onStepFinished: ({ stepIndex }) => {
        if (page !== undefined) urlAtStepEnd.set(stepIndex, page.url());
      },
    };
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/form' },
        { action: 'fill', target: { label: 'Query' }, value: 'nav' },
        { action: 'press', key: 'Enter', target: { label: 'Query' } },
      ]),
      await options(forms.origin, { observers: [observer] }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    // The navigation had started by the time the press step finished.
    expect(urlAtStepEnd.get(2)).toContain('/results?q=nav');
  });

  it('chords reach the page', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/form' },
        { action: 'fill', target: { label: 'Query' }, value: 'hello' },
        { action: 'press', key: 'Control+a', target: { label: 'Query' } },
        { action: 'press', key: 'Backspace' },
        { action: 'press', key: 'Enter' },
        { action: 'assertText', target: { css: 'h1' }, text: 'Results for' },
      ]),
      await options(forms.origin),
    );
    expect(outcome.stages.verification.status).toBe('passed');
    expect(outcome.events[3]).toMatchObject({ key: 'Backspace' });
  });
});
