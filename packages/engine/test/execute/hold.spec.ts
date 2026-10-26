import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunOptions, runScenario } from '../../src/index.ts';
import { type FixtureServer, startFixtureServer } from './fixture-server.ts';
import { scenario } from './scenario.ts';

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

describe('hold (spec 365)', () => {
  it('keeps the page on camera after a step, and after the last one', async () => {
    let lastFinishedAt = 0;
    let runFinishedAt = 0;
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/customers', hold: 1500 },
        { action: 'waitFor', target: { role: 'heading', name: 'Customers' } },
      ]),
      await options({
        endHoldMs: 2000,
        observers: [
          {
            onStepFinished: ({ stepIndex }) => {
              if (stepIndex === 1) lastFinishedAt = performance.now();
            },
            onRunFinished: () => {
              runFinishedAt = performance.now();
            },
          },
        ],
      }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const [first, second] = outcome.events;
    expect(first.holdMs).toBe(1500);
    // endMs is where the action ended, not the hold.
    expect(first.endMs - first.startMs).toBeLessThan(1500);
    expect(second.startMs - first.endMs).toBeGreaterThanOrEqual(1500);
    expect(second.holdMs).toBeUndefined();
    // The recording stops after the end hold, never before.
    expect(runFinishedAt - lastFinishedAt).toBeGreaterThanOrEqual(2000);
  });

  it('holds nothing after a failed step', async () => {
    let failedAt = 0;
    let runFinishedAt = 0;
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/' },
        {
          action: 'click',
          target: { testId: 'missing' },
          timeoutMs: 500,
          hold: 3000,
        },
      ]),
      await options({
        endHoldMs: 5000,
        observers: [
          {
            onStepFinished: ({ stepIndex }) => {
              if (stepIndex === 1) failedAt = performance.now();
            },
            onRunFinished: () => {
              runFinishedAt = performance.now();
            },
          },
        ],
      }),
    );
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 1 },
    });
    expect(outcome.events[1].holdMs).toBeUndefined();
    // Closing the context and saving the video takes a moment; no hold does.
    expect(runFinishedAt - failedAt).toBeLessThan(2000);
  });

  it('sleeps no end hold by default', async () => {
    let lastFinishedAt = 0;
    let runFinishedAt = 0;
    const outcome = await runScenario(
      scenario([{ action: 'navigate', path: '/' }]),
      await options({
        observers: [
          {
            onStepFinished: () => {
              lastFinishedAt = performance.now();
            },
            onRunFinished: () => {
              runFinishedAt = performance.now();
            },
          },
        ],
      }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(runFinishedAt - lastFinishedAt).toBeLessThan(2000);
  });
});
