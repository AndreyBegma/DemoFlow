import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunOptions, runScenario } from '../../src/index.ts';
import {
  type FixtureServer,
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
    record: false,
    ...extra,
  };
}

/** Every file under the run directory, relative to it. */
async function files(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe('check runs (record: false)', () => {
  it('runs and verifies every step and records nothing', async () => {
    const run = await options();
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/customers' },
        { action: 'waitFor', target: { role: 'heading', name: 'Customers' } },
        {
          action: 'assertText',
          target: { role: 'heading', name: 'Customers' },
          text: 'Customers',
        },
      ]),
      run,
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.verification.status).toBe('passed');
    expect(outcome.stages.recording).toEqual({ status: 'skipped' });
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([0, 1, 2]);
    expect(outcome.videoPath).toBeUndefined();
    expect(outcome.syncMark).toBeUndefined();
    expect(await files(run.runDir)).toEqual([]);
  });

  it('fails verification on an assertion that does not hold', async () => {
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/customers' },
        { action: 'waitFor', target: { role: 'heading', name: 'Customers' } },
        {
          action: 'assertText',
          target: { role: 'heading', name: 'Customers' },
          text: 'Invoices',
          timeoutMs: 500,
        },
      ]),
      await options(),
    );
    expect(outcome.stages.verification).toMatchObject({
      status: 'failed',
      error: { stepIndex: 2 },
    });
    expect(outcome.stages.recording).toEqual({ status: 'skipped' });
    expect(outcome.status).toBe('failed');
    expect(outcome.videoPath).toBeUndefined();
  });

  it('runs the off-camera steps before the checked ones', async () => {
    const outcome = await runScenario(
      scenario(
        [{ action: 'fill', target: { label: 'Password' }, value: 'visible' }],
        {
          setup: [
            { action: 'navigate', path: SIGN_IN_PATH },
            { action: 'navigate', path: '/login' },
          ],
        },
      ),
      await options(),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.recording).toEqual({ status: 'skipped' });
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([2]);
    expect(outcome.videoPath).toBeUndefined();
  });
});
