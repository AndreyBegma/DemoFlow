import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EngineObserver,
  type RunOptions,
  runScenario,
} from '../../src/index.ts';
import {
  type FixtureServer,
  SESSION_COOKIE,
  SIGN_IN_PATH,
  startFixtureServer,
} from './fixture-server.ts';
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

/** What the recorded page holds when its first step starts. */
function firstRecordedStep(): {
  observer: EngineObserver;
  seen: { stepIndex?: number; url?: string; cookies?: string[] };
} {
  let page: Page | undefined;
  const seen: { stepIndex?: number; url?: string; cookies?: string[] } = {};
  const observer: EngineObserver = {
    onPageCreated({ page: created }) {
      page = created;
    },
    async onStepStarted({ stepIndex }) {
      if (page === undefined || seen.stepIndex !== undefined) return;
      seen.stepIndex = stepIndex;
      seen.url = page.url();
      seen.cookies = (await page.context().cookies()).map(
        (cookie) => `${cookie.name}=${cookie.value}`,
      );
    },
  };
  return { observer, seen };
}

const signIn = [
  { action: 'navigate', path: SIGN_IN_PATH },
  { action: 'navigate', path: '/login' },
] as const;

const fillPassword = {
  action: 'fill',
  target: { label: 'Password' },
  value: 'visible',
} as const;

describe('off-camera steps', () => {
  it('records from the first visible step, signed in, on the page setup ended on', async () => {
    const { observer, seen } = firstRecordedStep();
    const outcome = await runScenario(
      scenario([fillPassword], { setup: [...signIn] }),
      await options({ observers: [observer] }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.recording.status).toBe('passed');
    expect(seen).toEqual({
      stepIndex: 2,
      url: `${fixture.origin}/login`,
      cookies: [`${SESSION_COOKIE}=signed-in`],
    });
    // Only the recorded step is on the timeline: its index counts setup.
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([2]);
    expect(outcome.syncMark?.offMs).toBeLessThanOrEqual(
      outcome.events[0]?.startMs ?? 0,
    );
    expect(outcome.videoPath).toBeDefined();
    expect((await stat(outcome.videoPath ?? '')).size).toBeGreaterThan(0);
  });

  it('treats leading record: false steps as setup', async () => {
    const { observer, seen } = firstRecordedStep();
    const outcome = await runScenario(
      scenario([
        ...signIn.map((step) => ({ ...step, record: false })),
        fillPassword,
        { action: 'marker', title: 'Done' },
      ]),
      await options({ observers: [observer] }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.recording.status).toBe('passed');
    expect(seen.cookies).toEqual([`${SESSION_COOKIE}=signed-in`]);
    expect(outcome.events.map((event) => event.action)).toEqual([
      'fill',
      'marker',
    ]);
  });

  it('fails the run on a failed setup step, with nothing recorded', async () => {
    const outcome = await runScenario(
      scenario([fillPassword], {
        setup: [
          signIn[1],
          {
            action: 'click',
            target: { role: 'button', name: 'No such button' },
            timeoutMs: 500,
          },
        ],
      }),
      await options(),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.stages.execution).toMatchObject({
      status: 'failed',
      error: { stepIndex: 1 },
    });
    expect(outcome.stages.recording.status).toBe('skipped');
    expect(outcome.videoPath).toBeUndefined();
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([1]);
  });

  it('keeps the origin allowlist off camera', async () => {
    const outcome = await runScenario(
      scenario([fillPassword], {
        setup: [{ action: 'navigate', url: 'https://example.com/' }],
      }),
      await options(),
    );
    expect(outcome.stages.readiness.error).toMatchObject({
      message: 'origin-not-allowed https://example.com',
      stepIndex: 0,
    });
  });
});
