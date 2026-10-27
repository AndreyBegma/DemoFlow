import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolvePacing,
  type Step,
  type StepInput,
  StepSchema,
} from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stepPace } from '../../src/execute/pacing.ts';
import {
  type EngineObserver,
  type RunOptions,
  runScenario,
} from '../../src/index.ts';
import {
  type FixtureServer,
  SIGN_IN_PATH,
  startFixtureServer,
} from './fixture-server.ts';
import { scenario } from './scenario.ts';

function step(input: StepInput): Step {
  return StepSchema.parse(input);
}

const onCamera = { onCamera: true, recording: true, last: false };
const defaults = resolvePacing(undefined);

describe('stepPace', () => {
  it('dwells after a visible step and types at the default speed', () => {
    expect(defaults).toEqual({
      stepDwellMs: 1_000,
      typingDelayMs: 80,
    });
    for (const input of [
      { action: 'navigate', path: '/' },
      { action: 'click', target: { text: 'Go' } },
      { action: 'fill', target: { label: 'Name' }, value: 'Ada' },
      { action: 'select', target: { label: 'Size' }, option: 'L' },
      { action: 'press', key: 'Enter' },
      { action: 'assertVisible', target: { text: 'Done' } },
    ] as const) {
      expect(stepPace(step(input), defaults, onCamera)).toEqual({
        dwellMs: 1_000,
        typingDelayMs: 80,
      });
    }
  });

  it('does not dwell after a step with nothing new to see', () => {
    for (const input of [
      { action: 'wait', ms: 500 },
      { action: 'marker', title: 'Scene' },
      { action: 'waitFor', target: { text: 'Done' } },
      { action: 'waitForReady', name: 'list' },
      { action: 'screenshot', name: 'shot' },
    ] as const) {
      expect(stepPace(step(input), defaults, onCamera).dwellMs).toBe(0);
    }
  });

  it('takes the scenario pacing, and a step overrides it', () => {
    const pacing = resolvePacing({ stepDwellMs: 300, typingDelayMs: 20 });
    expect(pacing.typingDelayMs).toBe(20);
    const fill = {
      action: 'fill',
      target: { label: 'Name' },
      value: 'Ada',
    } as const;
    expect(stepPace(step(fill), pacing, onCamera)).toEqual({
      dwellMs: 300,
      typingDelayMs: 20,
    });
    expect(
      stepPace(
        step({ ...fill, hold: 2_000, typingDelayMs: 150 }),
        pacing,
        onCamera,
      ),
    ).toEqual({ dwellMs: 2_000, typingDelayMs: 150 });
    // 0 turns the dwell off; a marker may ask for one.
    expect(stepPace(step({ ...fill, hold: 0 }), pacing, onCamera)).toEqual({
      dwellMs: 0,
      typingDelayMs: 20,
    });
    expect(
      stepPace(
        step({ action: 'marker', title: 'Scene', hold: 800 }),
        pacing,
        onCamera,
      ).dwellMs,
    ).toBe(800);
  });

  it('leaves the default dwell off the last step: the end hold follows it', () => {
    const click = step({ action: 'click', target: { text: 'Go' } });
    const last = { ...onCamera, last: true };
    expect(stepPace(click, defaults, last).dwellMs).toBe(0);
    expect(
      stepPace({ ...click, hold: 500 } as Step, defaults, last).dwellMs,
    ).toBe(500);
  });

  it('does not slow down off-camera steps or a check run', () => {
    const fill = step({
      action: 'fill',
      target: { label: 'Name' },
      value: 'Ada',
      hold: 2_000,
    });
    expect(stepPace(fill, defaults, { ...onCamera, onCamera: false })).toEqual({
      dwellMs: 0,
      typingDelayMs: 0,
    });
    expect(
      stepPace({ ...fill, typingDelayMs: 50 } as Step, defaults, {
        ...onCamera,
        onCamera: false,
      }).typingDelayMs,
    ).toBe(50);
    // A check run adds no default dwell; a step's own hold still applies.
    const plain = { ...fill, hold: undefined } as Step;
    expect(
      stepPace(plain, defaults, { ...onCamera, recording: false }),
    ).toEqual({ dwellMs: 0, typingDelayMs: 80 });
  });
});

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

/** When the last step finished and when the run did, in wall-clock ms. */
function endWatch(): {
  observer: EngineObserver;
  times: { lastStepMs?: number; finishedMs?: number };
} {
  const times: { lastStepMs?: number; finishedMs?: number } = {};
  return {
    times,
    observer: {
      onStepFinished() {
        times.lastStepMs = Date.now();
      },
      onRunFinished() {
        times.finishedMs = Date.now();
      },
    },
  };
}

const fillPassword = {
  action: 'fill',
  target: { label: 'Password' },
  value: 'abc',
} as const;

describe('a paced run', () => {
  it('dwells after each visible step, then holds the final frame', async () => {
    const { observer, times } = endWatch();
    const outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/login' },
          fillPassword,
          { action: 'wait', ms: 200 },
          { ...fillPassword, hold: 0 },
          { action: 'marker', title: 'Done' },
        ],
        { pacing: { stepDwellMs: 400, typingDelayMs: 50 } },
      ),
      await options({ observers: [observer], endHoldMs: 700 }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    const [navigate, fill, wait, refill, marker] = outcome.events;
    expect(navigate?.holdMs).toBe(400);
    expect(fill?.holdMs).toBe(400);
    expect(wait?.holdMs).toBeUndefined();
    expect(refill?.holdMs).toBeUndefined();
    expect(marker?.holdMs).toBeUndefined();
    // The next step starts after the dwell, and an explicit wait adds to it.
    expect(
      (fill?.startMs ?? 0) - (navigate?.endMs ?? 0),
    ).toBeGreaterThanOrEqual(400);
    expect((refill?.startMs ?? 0) - (fill?.endMs ?? 0)).toBeGreaterThanOrEqual(
      600,
    );
    // Three characters at 50 ms: two gaps between them at least.
    expect((fill?.endMs ?? 0) - (fill?.startMs ?? 0)).toBeGreaterThanOrEqual(
      100,
    );
    expect(
      (times.finishedMs ?? 0) - (times.lastStepMs ?? 0),
    ).toBeGreaterThanOrEqual(700);
  });

  it('does not slow down setup steps', async () => {
    // Wall-clock ms between the end of setup step 0 and the start of step 1.
    let finished0: number | undefined;
    let gapMs: number | undefined;
    const observer: EngineObserver = {
      onStepFinished({ stepIndex }) {
        if (stepIndex === 0) finished0 = Date.now();
      },
      onStepStarted({ stepIndex }) {
        if (stepIndex === 1 && finished0 !== undefined) {
          gapMs = Date.now() - finished0;
        }
      },
    };
    const outcome = await runScenario(
      scenario([fillPassword], {
        setup: [
          { action: 'navigate', path: SIGN_IN_PATH },
          { action: 'navigate', path: '/login' },
        ],
        pacing: { stepDwellMs: 5_000 },
      }),
      await options({ observers: [observer] }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(gapMs).toBeDefined();
    expect(gapMs ?? Infinity).toBeLessThan(2_000);
  });

  it('neither dwells nor holds in a check run', async () => {
    const outcome = await runScenario(
      scenario([{ action: 'navigate', path: '/login' }, fillPassword], {
        pacing: { stepDwellMs: 5_000 },
      }),
      await options({ record: false, endHoldMs: 0 }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.events.every((event) => event.holdMs === undefined)).toBe(
      true,
    );
    // Two 5 s dwells would take 10 s.
    expect(
      Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt),
    ).toBeLessThan(8_000);
  });

  it('does not hold the end of a failed run', async () => {
    const { observer, times } = endWatch();
    const outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/login' },
          {
            action: 'click',
            target: { role: 'button', name: 'No such button' },
            timeoutMs: 300,
          },
        ],
        { pacing: { stepDwellMs: 0 } },
      ),
      await options({ observers: [observer], endHoldMs: 5_000 }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.events.at(-1)?.holdMs).toBeUndefined();
    expect((times.finishedMs ?? 0) - (times.lastStepMs ?? 0)).toBeLessThan(
      5_000,
    );
  });
});
