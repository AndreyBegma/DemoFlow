import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Read-only helper of the engine's tests: serves the built fixture on an ephemeral port.
import {
  type FixtureServer,
  startFixtureServer,
} from '../../../../packages/engine/test/execute/fixture-server.ts';

const CLI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const REPO = path.resolve(CLI_DIR, '../..');
const FIXTURE_SCENARIOS = path.join(REPO, 'apps/fixture/demoflow');
const MAIN = path.join(CLI_DIR, 'dist/main.js');

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  /** From the last stdout output to the process exiting. */
  afterOutputMs: number;
}

/** Runs the built CLI as a real process: argument array, no shell. */
function demoflow(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd,
      env: { ...process.env, FIXTURE_PASSWORD: '', DEMOFLOW_HOME: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    let outputAt = performance.now();
    let exitedAt = 0;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      outputAt = performance.now();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', () => {
      exitedAt = performance.now();
    });
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, afterOutputMs: exitedAt - outputAt }),
    );
  });
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

let fixture: FixtureServer;
let project: string;
let out: string;

beforeAll(async () => {
  // The CLI's own dist is not a dependency of `test` in turbo: build it here.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
      cwd: CLI_DIR,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(build).toBe(0);

  fixture = await startFixtureServer();
  project = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-project-'));
  out = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-out-'));
  await writeFile(
    path.join(project, 'demoflow.config.json'),
    JSON.stringify({ baseUrl: fixture.origin }),
  );
  await cp(FIXTURE_SCENARIOS, path.join(project, 'demoflow'), {
    recursive: true,
  });
});

afterAll(async () => {
  await fixture?.close();
  await Promise.all(
    [project, out].map((dir) =>
      dir === undefined ? undefined : rm(dir, { recursive: true, force: true }),
    ),
  );
});

const scenario = (name: string) =>
  path.join(project, 'demoflow', `${name}.demo.json`);

describe('demoflow validate', () => {
  it('exits 0 on a valid scenario', async () => {
    const result = await demoflow(['validate', scenario('customers')], project);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('is valid');
  });

  it('exits 2 and prints the step path for a { role, testId } locator', async () => {
    const bad = JSON.parse(await readFile(scenario('customers'), 'utf8'));
    const index = bad.steps.findIndex(
      (step: { target?: unknown }) => step.target !== undefined,
    );
    bad.steps[index].target = { role: 'button', testId: 'x' };
    const file = path.join(project, 'demoflow', 'bad.demo.json');
    await writeFile(file, JSON.stringify(bad));

    const result = await demoflow(['validate', file], project);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`steps[${index}].target`);
  });
});

describe('demoflow run', () => {
  it('--json: exit 0, one JSON object on stdout, one existing MP4', async () => {
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out],
      project,
    );
    expect(result.code, result.stderr).toBe(0);
    // The CLI never calls `process.exit`: it leaves once nothing is left open.
    expect(result.afterOutputMs).toBeLessThan(5_000);
    const json = JSON.parse(result.stdout);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(json.status).toBe('completed');
    expect(json.renders).toHaveLength(1);
    expect(json.renders[0].file).toBe('render/ffmpeg.mp4');
    expect(await exists(path.join(json.runDir, json.renders[0].file))).toBe(
      true,
    );
    expect(json.runDir.startsWith(path.join(out, 'runs'))).toBe(true);
    expect(json.scenarioId).toBe('demoflow/customers.demo.json');
  });

  it('prints a human summary by default', async () => {
    const result = await demoflow(
      ['run', scenario('customers'), '--out', out],
      project,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('completed');
    expect(result.stdout).toContain('ffmpeg.mp4');
  });

  it('a failing scenario exits 1 with status failed', async () => {
    const result = await demoflow(
      ['run', scenario('failing'), '--json', '--out', out],
      project,
    );
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('failed');
  });

  it('exits 2 before a browser starts when valueFrom.env is missing', async () => {
    const result = await demoflow(
      ['run', scenario('login'), '--json', '--out', out],
      project,
    );
    expect(result.code).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json.stages.readiness.error.message).toContain(
      'missing-env FIXTURE_PASSWORD',
    );
    expect(await exists(path.join(json.runDir, 'source.webm'))).toBe(false);
  });

  it('reads valueFrom from the process environment', async () => {
    const result = await demoflow(
      ['run', scenario('login'), '--json', '--out', out],
      project,
      { FIXTURE_PASSWORD: 'correct horse' },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('correct horse');
  });

  it('--base-url outside allowedOrigins exits 2 with origin-not-allowed', async () => {
    const result = await demoflow(
      [
        'run',
        scenario('customers'),
        '--json',
        '--base-url',
        'https://example.com',
        '--out',
        out,
      ],
      project,
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).stages.readiness.error.message).toContain(
      'origin-not-allowed',
    );
  });

  it('--run-id writes to <home>/runs/<id>/ and a reused id exits 2', async () => {
    const args = (id: string) => [
      'run',
      scenario('customers'),
      '--json',
      '--out',
      out,
      '--run-id',
      id,
    ];
    const first = await demoflow(args('named-run'), project);
    expect(first.code, first.stderr).toBe(0);
    const json = JSON.parse(first.stdout);
    expect(json.runId).toBe('named-run');
    expect(json.runDir).toBe(path.join(out, 'runs', 'named-run'));
    expect(await exists(path.join(json.runDir, json.renders[0].file))).toBe(
      true,
    );

    const again = await demoflow(args('named-run'), project);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('invalid-run-id');
    expect(again.stdout).toBe('');
  });

  it.each([
    '../escape',
    'a/b',
    '..',
    '',
  ])('--run-id %j exits 2 before anything runs', async (id) => {
    const result = await demoflow(
      ['run', scenario('customers'), '--out', out, '--run-id', id],
      project,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('invalid-run-id');
    expect(result.stdout).toBe('');
  });

  it('--run-id and --project are hidden from --help', async () => {
    const result = await demoflow(['run', '--help'], project);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--json');
    expect(result.stdout).not.toContain('run-id');
    expect(result.stdout).not.toContain('--project');
  });

  it('--project runs a scenario kept outside the project as inline/<name>', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-inline-'));
    try {
      const file = path.join(outside, 'staged.demo.json');
      await cp(scenario('customers'), file);
      const result = await demoflow(
        ['run', file, '--json', '--out', out, '--project', project],
        outside,
      );
      expect(result.code, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.status).toBe('completed');
      expect(json.scenarioId).toBe('inline/staged.demo.json');
      expect(await exists(path.join(json.runDir, json.renders[0].file))).toBe(
        true,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('--project without demoflow.config.json exits 2 no-project-config', async () => {
    const result = await demoflow(
      ['run', scenario('customers'), '--out', out, '--project', out],
      project,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no-project-config');
  });

  it('exits 2 no-project-config when no config is above the scenario', async () => {
    const lonely = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-lonely-'));
    try {
      const file = path.join(lonely, 'a.demo.json');
      await cp(scenario('customers'), file);
      const result = await demoflow(['run', file, '--out', out], lonely);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('no-project-config');
      expect(result.stdout).toBe('');
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
  });
});
