import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Read-only helper of the engine's tests: serves the built fixture on an ephemeral port.
import {
  type FixtureServer,
  startFixtureServer,
} from '../../../../packages/engine/test/execute/fixture-server.ts';
import { AppStartError } from '../../src/app/dev-server.ts';
import { CommandError } from '../../src/commands/errors.ts';
import type { Io } from '../../src/commands/io.ts';
import {
  type RunDeps,
  type RunFlags,
  runCommand,
} from '../../src/commands/run.ts';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const FIXTURE_SCENARIOS = path.join(REPO, 'apps/fixture/demoflow');

let fixture: FixtureServer;
let project: string;

beforeAll(async () => {
  fixture = await startFixtureServer();
  project = await mkdtemp(path.join(tmpdir(), 'demoflow-check-project-'));
  await writeFile(
    path.join(project, 'demoflow.config.json'),
    JSON.stringify({ baseUrl: fixture.origin }),
  );
  await cp(FIXTURE_SCENARIOS, path.join(project, 'demoflow'), {
    recursive: true,
  });
});

afterAll(async () => {
  await fixture.close();
  await rm(project, { recursive: true, force: true });
});

/** An in-process `demoflow run` with a start hook that counts app starts. */
async function harness(start?: RunDeps['startApp']) {
  const home = await mkdtemp(path.join(tmpdir(), 'demoflow-check-home-'));
  const io: Io & { out: string; err: string } = {
    out: '',
    err: '',
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  let starts = 0;
  let stops = 0;
  let runs = 0;
  const run = (file: string | undefined, flags: RunFlags) =>
    runCommand(file, flags, io, {
      host: {
        platform: process.platform,
        env: {
          DEMOFLOW_HOME: home,
          DEMOFLOW_NO_REPORT: '1',
          // landing, login and phone sign in; any password does.
          FIXTURE_PASSWORD: 'correct horse',
        },
        homedir: path.join(home, 'user'),
      },
      cwd: project,
      runId: () => `check-${++runs}`,
      startApp: async (...args) => {
        starts++;
        if (start !== undefined) return start(...args);
        return {
          started: true,
          stop: async () => {
            stops++;
          },
        };
      },
    });
  return {
    io,
    run,
    home,
    runsDir: path.join(home, 'runs'),
    counts: () => ({ starts, stops }),
  };
}

function scenario(name: string): string {
  return path.join(project, 'demoflow', `${name}.demo.json`);
}

function resultOf(runDir: string): RunResult {
  return JSON.parse(
    readFileSync(path.join(runDir, 'result.json'), 'utf8'),
  ) as RunResult;
}

async function refusal(promise: Promise<unknown>): Promise<CommandError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

describe('demoflow run --check', () => {
  it('runs and verifies one scenario, recording and rendering nothing', async () => {
    const { io, run, runsDir } = await harness();
    const code = await run(scenario('customers'), { check: true });
    expect(code).toBe(0);
    const runDir = path.join(runsDir, 'check-1');
    const result = resultOf(runDir);
    expect(result.status).not.toBe('failed');
    expect(result.stages.recording.status).toBe('skipped');
    expect(result.stages.rendering.status).toBe('skipped');
    expect(result.stages.verification.status).toBe('passed');
    expect(result.renders).toEqual([]);
    expect(
      readdirSync(runDir).filter((file) => file.endsWith('.webm')),
    ).toEqual([]);
    expect(readdirSync(runDir).filter((file) => file.endsWith('.mp4'))).toEqual(
      [],
    );
    expect(io.out).toBe(
      'passed  demoflow/customers.demo.json\n1 passed, 0 failed\n',
    );
  });

  it('fails the check of a failing scenario: exit 1, verification failed', async () => {
    const { io, run, runsDir } = await harness();
    const code = await run(scenario('failing'), { check: true, json: true });
    expect(code).toBe(1);
    const result = resultOf(path.join(runsDir, 'check-1'));
    expect(result.status).toBe('failed');
    expect(result.stages.verification.status).toBe('failed');
    const printed = JSON.parse(io.out) as {
      check: true;
      passed: number;
      failed: number;
      runs: { scenarioId: string; status: string; runDir: string }[];
    };
    expect(printed).toMatchObject({ check: true, passed: 0, failed: 1 });
    expect(printed.runs.map((entry) => entry.scenarioId)).toEqual([
      'demoflow/failing.demo.json',
    ]);
  });

  it('runs every scenario of the project against one app start, leaving out the excluded', async () => {
    const { io, run, runsDir, counts } = await harness();
    const code = await run(undefined, {
      check: true,
      exclude: [
        'login.demo.json',
        'demoflow/failing.demo.json',
        'gone.demo.json',
      ],
    });
    expect(counts()).toEqual({ starts: 1, stops: 1 });
    const expected = [
      'demoflow/customers-repeat.demo.json',
      'demoflow/customers.demo.json',
      'demoflow/landing.demo.json',
      'demoflow/masked-elements.demo.json',
      'demoflow/phone.demo.json',
      'demoflow/tour.demo.json',
    ];
    const lines = io.out.trimEnd().split('\n');
    expect(lines.slice(0, -1).map((line) => line.split(/\s+/)[1])).toEqual(
      expected,
    );
    expect(lines.at(-1), io.out).toBe(`${expected.length} passed, 0 failed`);
    expect(code).toBe(0);
    for (const runDir of readdirSync(runsDir)) {
      const result = resultOf(path.join(runsDir, runDir));
      expect(result.stages.recording.status).toBe('skipped');
      expect(result.renders).toEqual([]);
    }
    expect(readdirSync(runsDir)).toHaveLength(expected.length);
  }, 180_000);

  it('prints one check progress line per scenario of a pass', async () => {
    const { io, run } = await harness();
    await run(undefined, {
      check: true,
      progress: true,
      json: true,
      exclude: [
        'login.demo.json',
        'customers-repeat.demo.json',
        'landing.demo.json',
        'masked-elements.demo.json',
        'phone.demo.json',
        'tour.demo.json',
      ],
    });
    const checks = io.out
      .split('\n')
      .filter((line) => line.includes('"phase":"check"'))
      .map((line) => JSON.parse(line) as unknown);
    expect(checks).toEqual([
      { type: 'progress', phase: 'check', run: 1, runs: 2 },
      { type: 'progress', phase: 'check', run: 2, runs: 2 },
    ]);
  }, 60_000);

  it.each<[string, string | undefined, RunFlags]>([
    ['--format', 'customers', { format: ['gif'] }],
    ['--headed', 'customers', { headed: true }],
    ['--run-id in a pass', undefined, { runId: 'mine' }],
    ['--exclude with a scenario', 'customers', { exclude: ['x.demo.json'] }],
  ])('refuses %s: exit 2, nothing started or written', async (_, name, extra) => {
    const { io, run, runsDir, counts } = await harness();
    const file = name === undefined ? undefined : scenario(name);
    const error = await refusal(run(file, { check: true, ...extra }));
    expect(error.code).toBe('check-flag');
    expect(error.exitCode).toBe(2);
    expect(counts().starts).toBe(0);
    expect(io.out).toBe('');
    expect(existsSync(runsDir)).toBe(false);
  });

  it('fails every scenario of a pass whose app never answered, each with its own result', async () => {
    const { io, run, runsDir } = await harness(async () => {
      throw new AppStartError('the app did not answer');
    });
    const code = await run(undefined, {
      check: true,
      exclude: [
        'customers-repeat.demo.json',
        'landing.demo.json',
        'login.demo.json',
        'masked-elements.demo.json',
        'phone.demo.json',
        'tour.demo.json',
      ],
    });
    expect(code).toBe(1);
    expect(readdirSync(runsDir).sort()).toEqual(['check-1', 'check-2']);
    for (const runDir of ['check-1', 'check-2']) {
      const result = resultOf(path.join(runsDir, runDir));
      expect(result.stages.readiness.status).toBe('failed');
      expect(result.stages.recording.status).toBe('skipped');
    }
    expect(io.out).toMatch(/0 passed, 2 failed\n$/);
  });

  it('refuses a run with no scenario and no --check', async () => {
    const { run } = await harness();
    const error = await refusal(run(undefined, {}));
    expect(error.code).toBe('missing-scenario');
    expect(error.exitCode).toBe(2);
  });
});
