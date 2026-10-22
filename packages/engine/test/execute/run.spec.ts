import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Box, TimelineEvent } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOptions,
  runScenario,
  SYNC_MARK_HOLD_MS,
} from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { scenario } from './scenario.ts';

declare global {
  interface Window {
    __pointerDowns?: Box[];
  }
}

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

async function options(extra: Partial<RunOptions> = {}): Promise<RunOptions> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-engine-'));
  runDirs.push(runDir);
  return {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
    env: {},
    ...extra,
  };
}

/** Records which hooks fired, in order. */
function recorder(): EngineObserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onRunStarted: () => void calls.push('runStarted'),
    onBrowserLaunched: () => void calls.push('browserLaunched'),
    onPageCreated: () => void calls.push('pageCreated'),
    onStepStarted: ({ stepIndex }) =>
      void calls.push(`stepStarted ${stepIndex}`),
    onStepFinished: ({ stepIndex }) =>
      void calls.push(`stepFinished ${stepIndex}`),
    onRunFinished: () => void calls.push('runFinished'),
  };
}

function expectWithin1px(actual: Box | undefined, expected: Box): void {
  expect(actual).toBeDefined();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs((actual as Box)[key] - expected[key])).toBeLessThanOrEqual(
      1,
    );
  }
}

describe('readiness', () => {
  it('refuses an origin outside the allowlist without launching a browser', async () => {
    const observer = recorder();
    const outcome = await runScenario(
      scenario([{ action: 'navigate', url: 'https://example.com' }]),
      await options({
        allowedOrigins: [fixture.origin.replace('127.0.0.1', 'localhost')],
        baseUrl: undefined,
        observers: [observer],
      }),
    );
    expect(outcome.stages.readiness).toMatchObject({
      status: 'failed',
      error: {
        message: 'origin-not-allowed https://example.com',
        stepIndex: 0,
      },
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.events).toEqual([]);
    expect(outcome.videoPath).toBeUndefined();
    expect(observer.calls).toEqual(['runStarted', 'runFinished']);
  });

  it('reports a missing environment variable before the browser starts', async () => {
    const observer = recorder();
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/login' },
        {
          action: 'fill',
          target: { label: 'Password' },
          valueFrom: { env: 'FIXTURE_PASSWORD' },
        },
      ]),
      await options({ env: {}, observers: [observer] }),
    );
    expect(outcome.stages.readiness).toMatchObject({
      status: 'failed',
      error: { message: 'missing-env FIXTURE_PASSWORD', stepIndex: 1 },
    });
    expect(outcome.stages.execution.status).toBe('skipped');
    expect(observer.calls).not.toContain('browserLaunched');
  });
});

describe('the customers flow', () => {
  let outcome: Awaited<ReturnType<typeof runScenario>>;
  const pointerDowns = new Map<number, Box>();
  const observer = recorder();

  beforeAll(async () => {
    let page: Page | undefined;
    const clickTime: EngineObserver = {
      // Records the box of what the real pointer pressed, at the moment it pressed.
      onPageCreated: async (event) => {
        page = event.page;
        await page.addInitScript(() => {
          window.__pointerDowns = [];
          window.addEventListener(
            'pointerdown',
            (pointer) => {
              const element = pointer.target as Element;
              const pressed = element.closest('button') ?? element;
              const { x, y, width, height } = pressed.getBoundingClientRect();
              window.__pointerDowns?.push({ x, y, width, height });
            },
            true,
          );
        });
      },
      onStepFinished: async ({ stepIndex, step }) => {
        if (step.action !== 'click' || page === undefined) return;
        const box = await page.evaluate(() => window.__pointerDowns?.at(-1));
        if (box !== undefined) pointerDowns.set(stepIndex, box);
      },
    };
    outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/customers' },
          { action: 'marker', title: 'Customers', kind: 'scene' },
          {
            action: 'fill',
            target: { placeholder: 'Search customers' },
            value: 'zz',
          },
          { action: 'fill', target: { label: 'Search customers' }, value: '' },
          { action: 'click', target: { role: 'button', name: 'New customer' } },
          { action: 'fill', target: { label: 'Name' }, value: 'Ada Lovelace' },
          {
            action: 'fill',
            target: { label: 'Email' },
            value: 'ada@example.com',
          },
          { action: 'select', target: { label: 'Plan' }, option: 'Pro' },
          {
            action: 'click',
            target: { role: 'button', name: 'Create', exact: true },
            caption: 'Create the customer',
            zoom: 2,
          },
          {
            action: 'assertText',
            target: { css: 'tbody' },
            text: 'Ada Lovelace',
          },
          { action: 'assertVisible', target: { text: 'ada@example.com' } },
        ],
        { viewport: { width: 1920, height: 1080 } },
      ),
      await options({ observers: [observer, clickTime] }),
    );
  });

  it('passes execution and verification, and leaves rendering pending', () => {
    expect(outcome.stages.readiness.status).toBe('passed');
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.verification.status).toBe('passed');
    expect(outcome.stages.recording.status).toBe('passed');
    expect(outcome.stages.rendering.status).toBe('pending');
    expect(outcome.status).toBe('running');
  });

  it('records the video in the run directory', async () => {
    expect(outcome.videoPath).toBeDefined();
    const video = outcome.videoPath as string;
    expect(path.extname(video)).toBe('.webm');
    expect((await stat(video)).size).toBeGreaterThan(0);
  });

  it('notifies observers in order', () => {
    expect(observer.calls.slice(0, 3)).toEqual([
      'runStarted',
      'browserLaunched',
      'pageCreated',
    ]);
    expect(observer.calls.at(-1)).toBe('runFinished');
    expect(observer.calls).toContain('stepFinished 10');
  });

  it('times every event from page creation, in order', () => {
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    let previous = 0;
    for (const event of outcome.events) {
      expect(event.startMs).toBeGreaterThanOrEqual(previous);
      expect(event.endMs).toBeGreaterThanOrEqual(event.startMs);
      previous = event.endMs;
    }
  });

  it('records a sync mark held for its hold and cleared before the first event', () => {
    const mark = outcome.syncMark;
    expect(mark?.colour).toBe('#ff00ff');
    // Both edges are the page frame times the hold loop compared, mapped with
    // one shift, so the hold is whole (#64).
    expect((mark?.offMs ?? 0) - (mark?.onMs ?? 0)).toBeGreaterThanOrEqual(
      SYNC_MARK_HOLD_MS,
    );
    expect(mark?.offMs).toBeLessThanOrEqual(outcome.events[0]?.startMs ?? 0);
  });

  it('moves the real pointer before every click, from the viewport centre', () => {
    const clicks = outcome.events.filter((event) => event.action === 'click');
    expect(clicks).toHaveLength(2);
    expect(clicks[0].pointer?.from).toEqual({ x: 960, y: 540 });
    expect(clicks[1].pointer?.from).toEqual(clicks[0].pointer?.to);
    // Only a step that asks for zoom carries it (#163).
    expect(clicks[0]).not.toHaveProperty('zoom');
    for (const click of clicks) {
      expect(click.pointer?.to).toBeDefined();
      expect(click.target?.box).toBeDefined();
    }
  });

  it('records the Create box within 1 px of the box pressed at click time', () => {
    const create = outcome.events[8] as TimelineEvent;
    expect(create.caption).toBe('Create the customer');
    expect(create.zoom).toBe(2);
    const pressed = pointerDowns.get(8);
    expect(pressed).toBeDefined();
    expectWithin1px(create.target?.box, pressed as Box);
  });

  it('writes fill values, markers and assertions', () => {
    expect(outcome.events[1].marker).toEqual({
      title: 'Customers',
      kind: 'scene',
    });
    expect(outcome.events[5]).toMatchObject({ value: 'Ada Lovelace' });
    expect(outcome.events[5].masked).toBeUndefined();
    expect(outcome.events[9].assertion).toEqual({ passed: true });
  });
});

describe('masked values', () => {
  it('types a secret but never reports it', async () => {
    const secret = 'correct-horse-battery';
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/login' },
        { action: 'fill', target: { label: 'Email' }, value: 'a@example.com' },
        {
          action: 'fill',
          target: { label: 'Password' },
          valueFrom: { env: 'FIXTURE_PASSWORD' },
        },
        { action: 'click', target: { role: 'button', name: 'Sign in' } },
        { action: 'assertText', target: { role: 'heading' }, text: 'Welcome' },
      ]),
      await options({ env: { FIXTURE_PASSWORD: secret } }),
    );
    expect(outcome.stages.verification.status).toBe('passed');
    expect(outcome.events[2]).toMatchObject({ masked: true, value: '***' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});

describe('failures', () => {
  it('stops at an assertion that does not hold and still saves the video', async () => {
    const observer = recorder();
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/customers' },
        // The assertion's short timeout also bounds its wait for the heading;
        // on a slow runner (video recording on macOS) that wait alone
        // exceeded 500 ms, so the page is waited for with the default timeout.
        { action: 'waitFor', target: { role: 'heading', name: 'Customers' } },
        {
          action: 'assertText',
          target: { role: 'heading', name: 'Customers' },
          text: 'Invoices',
          timeoutMs: 500,
        },
        { action: 'click', target: { role: 'button', name: 'New customer' } },
      ]),
      await options({ observers: [observer] }),
    );
    // First, so a step that failed before the assertion shows its own error.
    expect(
      outcome.stages.execution,
      `execution stage: ${JSON.stringify(outcome.stages.execution)}`,
    ).toMatchObject({
      status: 'skipped',
    });
    expect(outcome.stages.verification).toMatchObject({
      status: 'failed',
      error: {
        stepIndex: 2,
        message:
          'expected {"role":"heading","name":"Customers"} to contain "Invoices", got "Customers"',
      },
    });
    expect(outcome.stages.recording.status).toBe('passed');
    expect(outcome.status).toBe('failed');
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([0, 1, 2]);
    expect(outcome.events[2].assertion?.passed).toBe(false);
    expect(observer.calls).not.toContain('stepStarted 3');
    expect((await stat(outcome.videoPath as string)).size).toBeGreaterThan(0);
  });

  it('fails execution when a locator times out', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/' },
        { action: 'click', target: { testId: 'missing' }, timeoutMs: 500 },
        { action: 'wait', ms: 1 },
      ]),
      await options(),
    );
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 1 },
    });
    expect(outcome.stages.verification.status).toBe('skipped');
    expect(outcome.stages.recording.status).toBe('passed');
    expect(outcome.events).toHaveLength(2);
    expect(outcome.events[1].error?.message).toMatch(/Timeout 500ms/);
  });

  it('stops a click that leaves for a foreign origin', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/' },
        { action: 'click', target: { role: 'link', name: 'Leave' } },
        { action: 'wait', ms: 1 },
      ]),
      await options({
        observers: [
          {
            onPageCreated: async ({ page }) => {
              // `.invalid` never resolves: the guard must act on the request, not a load.
              await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => {
                  const link = document.createElement('a');
                  link.href = 'http://leave.invalid/';
                  link.textContent = 'Leave';
                  document.body.append(link);
                });
              });
            },
          },
        ],
      }),
    );
    expect(outcome.stages.readiness.status).toBe('passed');
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: {
        message: 'origin-not-allowed http://leave.invalid',
        stepIndex: 1,
      },
    });
    expect(outcome.events).toHaveLength(2);
  });
});

describe('pointer, scroll and screenshot actions', () => {
  it('hovers with a real pointer path and a target box', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/hover' },
        { action: 'hover', target: { testId: 'hover-card' } },
      ]),
      await options(),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const hover = outcome.events[1];
    expect(hover.pointer?.from).toEqual({ x: 640, y: 360 });
    expect(hover.pointer?.to).toBeDefined();
    expect(hover.target?.box.width).toBeGreaterThan(0);
  });

  it('scrolls the page and a container, and records the offsets', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/long' },
        { action: 'scroll', to: 'bottom' },
        { action: 'scroll', to: 'bottom', within: { testId: 'log-panel' } },
        { action: 'scroll', target: { text: 'Section 3', exact: true } },
        { action: 'scroll', to: 'top' },
      ]),
      await options(),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const [, page, panel, section, top] = outcome.events;
    expect(page.scroll?.before.y).toBe(0);
    expect(page.scroll?.after.y).toBeGreaterThan(0);
    expect(page.scroll?.container).toBeUndefined();
    expect(panel.scroll?.after.y).toBeGreaterThan(0);
    expect(panel.scroll?.container?.height).toBeGreaterThan(0);
    expect(section.scroll?.after.y).toBeLessThan(
      section.scroll?.before.y as number,
    );
    expect(top.scroll?.after.y).toBe(0);
  });

  it('records the container offset the scroll settled at, not one read before it moved (#56)', async () => {
    // What the container really shows once each following `wait` ends.
    let page: Page | undefined;
    const settled = new Map<number, { y: number; max: number }>();
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/long' },
        { action: 'scroll', to: 'bottom', within: { testId: 'log-panel' } },
        { action: 'wait', ms: 1_000 },
        { action: 'scroll', to: 'top', within: { testId: 'log-panel' } },
        { action: 'wait', ms: 1_000 },
      ]),
      await options({
        observers: [
          {
            onPageCreated: (event) => {
              page = event.page;
            },
            onStepFinished: async ({ stepIndex, step }) => {
              if (step.action !== 'wait' || page === undefined) return;
              const panel = page.getByTestId('log-panel');
              settled.set(
                stepIndex,
                await panel.evaluate((element) => ({
                  y: element.scrollTop,
                  max: element.scrollHeight - element.clientHeight,
                })),
              );
            },
          },
        ],
      }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const [, down, , up] = outcome.events;
    const atBottom = settled.get(2);
    const atTop = settled.get(4);
    expect(atBottom?.max).toBeGreaterThan(0);
    expect(down.scroll?.after.y).toBe(atBottom?.y);
    expect(down.scroll?.after.y).toBe(atBottom?.max);
    expect(up.scroll?.before.y).toBe(atBottom?.y);
    expect(up.scroll?.after.y).toBe(atTop?.y);
    expect(up.scroll?.after.y).toBe(0);
  });

  it('settles at once when the container is already where the scroll goes', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/long' },
        { action: 'scroll', to: 'top', within: { testId: 'log-panel' } },
      ]),
      await options(),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const step = outcome.events[1];
    expect(step.scroll?.before).toEqual({ x: 0, y: 0 });
    expect(step.scroll?.after).toEqual({ x: 0, y: 0 });
    expect(step.endMs - step.startMs).toBeLessThan(2_000);
  });

  it('hands a screenshot to the observer and records its path', async () => {
    let png: Buffer | undefined;
    const runOptions = await options({
      observers: [
        {
          onScreenshot: (shot) => {
            png = shot.png;
            return `screenshots/${shot.name}.png`;
          },
        },
      ],
    });
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/' },
        { action: 'screenshot', name: 'home' },
        { action: 'wait', ms: 10 },
      ]),
      runOptions,
    );
    expect(outcome.events[1].screenshot).toBe('screenshots/home.png');
    expect(png?.subarray(1, 4).toString()).toBe('PNG');
    expect(
      outcome.events[2].endMs - outcome.events[2].startMs,
    ).toBeGreaterThanOrEqual(9);
    // The engine itself writes only the video into the run directory.
    const files = await readdir(runOptions.runDir);
    expect(files.every((file) => file.endsWith('.webm'))).toBe(true);
  });
});
