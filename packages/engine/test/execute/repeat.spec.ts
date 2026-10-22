import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScenarioStepInput, TemplateStepInput } from '@demoflow/core';
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

const CUSTOMERS = [
  { name: 'Grace Hopper', email: 'grace@example.com', expected: 'Grace' },
  { name: 'Alan Turing', email: 'alan@example.com', expected: 'Alan' },
  { name: 'Edsger Dijkstra', email: 'edsger@example.com', expected: 'Ken' },
];

const CREATE: TemplateStepInput[] = [
  { action: 'click', target: { role: 'button', name: 'New customer' } },
  { action: 'fill', target: { label: 'Name' }, value: '{{customer.name}}' },
  { action: 'fill', target: { label: 'Email' }, value: '{{customer.email}}' },
  { action: 'click', target: { role: 'button', name: 'Create', exact: true } },
];

/** Creates one customer per item through the dialog. */
function createEach(steps: TemplateStepInput[] = CREATE): ScenarioStepInput {
  return { action: 'repeat', each: 'customers', as: 'customer', steps };
}

/** …and checks the row after each, with the text the item expects. */
const checkRow: TemplateStepInput = {
  action: 'assertText',
  target: { css: 'tbody' },
  text: '{{customer.expected}}',
  timeoutMs: 1_000,
};

describe('repeat', () => {
  it('runs every iteration and tags each event with its origin', async () => {
    const outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/customers' },
          createEach(),
          { action: 'assertText', target: { css: 'tbody' }, text: 'Alan' },
        ],
        { data: { customers: CUSTOMERS.slice(0, 2) } },
      ),
      await options(),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.stages.verification.status).toBe('passed');
    expect(outcome.events.map((event) => event.stepIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(outcome.events.map((event) => event.origin)).toEqual([
      undefined,
      ...[0, 1].flatMap((iteration) =>
        Array.from({ length: 4 }, () => ({ repeatIndex: 1, iteration })),
      ),
      undefined,
    ]);
    expect(
      outcome.events
        .filter((event) => event.action === 'fill')
        .map((event) => event.value),
    ).toEqual([
      'Grace Hopper',
      'grace@example.com',
      'Alan Turing',
      'alan@example.com',
    ]);
  });

  it('reports the origin of a step that fails in the third iteration', async () => {
    const outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/customers' },
          createEach([...CREATE, checkRow]),
        ],
        {
          data: { customers: CUSTOMERS },
        },
      ),
      await options(),
    );
    expect(outcome.status).toBe('failed');
    // navigate, then 5 steps per iteration: the assertion of iteration 3 is 15.
    expect(outcome.stages.verification.error).toMatchObject({
      stepIndex: 15,
      origin: { repeatIndex: 1, iteration: 2 },
    });
    expect(outcome.events.at(-1)).toMatchObject({
      stepIndex: 15,
      origin: { repeatIndex: 1, iteration: 2 },
      assertion: { passed: false },
    });
  });

  it('keys a secret by expanded step: every iteration of a masked fill is masked', async () => {
    const secret = 'correct-horse-battery';
    const outcome = await runScenario(
      scenario(
        [
          { action: 'navigate', path: '/login' },
          {
            action: 'repeat',
            each: 'tries',
            steps: [
              {
                action: 'fill',
                target: { label: 'Password' },
                valueFrom: { env: 'FIXTURE_PASSWORD' },
              },
            ],
          },
        ],
        { data: { tries: [{ n: 1 }, { n: 2 }] } },
      ),
      await options({ env: { FIXTURE_PASSWORD: secret } }),
    );
    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.events.slice(1)).toMatchObject([
      { masked: true, value: '***' },
      { masked: true, value: '***' },
    ]);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('a missing secret inside a repeat fails readiness with the origin', async () => {
    const outcome = await runScenario(
      scenario(
        [
          {
            action: 'repeat',
            each: 'tries',
            steps: [
              {
                action: 'fill',
                target: { label: 'Password' },
                valueFrom: { env: 'FIXTURE_PASSWORD' },
              },
            ],
          },
        ],
        { data: { tries: [{ n: 1 }] } },
      ),
      await options(),
    );
    expect(outcome.stages.readiness.error).toEqual({
      message: 'missing-env FIXTURE_PASSWORD',
      stepIndex: 0,
      origin: { repeatIndex: 0, iteration: 0 },
    });
  });
});
