// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFfmpegRaw } from '@demoflow/renderer';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
// Read-only helper of the engine's tests: serves the built fixture on an ephemeral port.
import {
  type FixtureServer,
  startFixtureServer,
} from '../../../../packages/engine/test/execute/fixture-server.ts';
import { writeCredentials } from '../../src/auth/credentials.ts';
import { runnerPaths } from '../../src/runner/paths.ts';

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
      env: {
        ...process.env,
        FIXTURE_PASSWORD: '',
        DEMOFLOW_HOME: '',
        // A paired developer machine must not report from the test suite.
        DEMOFLOW_NO_REPORT: '1',
        ...env,
      },
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

describe('demoflow --version', () => {
  it("prints the package's version and exits 0", async () => {
    const { version } = JSON.parse(
      await readFile(path.join(CLI_DIR, 'package.json'), 'utf8'),
    ) as { version: string };
    const result = await demoflow(['--version'], project);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });
});

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

  it('exits 2 with the step path for a field missing in an item, before any run', async () => {
    const bad = JSON.parse(
      await readFile(scenario('customers-repeat'), 'utf8'),
    );
    bad.data.customers[3] = { name: 'Barbara Liskov' };
    const file = path.join(project, 'demoflow', 'bad-repeat.demo.json');
    await writeFile(file, JSON.stringify(bad));

    for (const args of [
      ['validate', file],
      ['run', file, '--out', out],
    ]) {
      const result = await demoflow(args, project);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'steps[1].steps[2].value: unknown field customer.email: missing in data.customers[3]',
      );
    }
  });
});

describe('demoflow run on a paired machine', () => {
  let home: string;
  let api: Server;
  let received: { auth: string | undefined; body: Record<string, unknown> }[];
  let status: number;

  const pairedEnv = (server: string) => {
    const env = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, 'xdg'),
      APPDATA: path.join(home, 'appdata'),
      DEMOFLOW_NO_REPORT: '',
      CI: '',
    };
    writeCredentials(
      { platform: process.platform, env, homedir: home },
      { server, token: 'dfr_test', runnerId: 'r1' },
    );
    return env;
  };
  const apiUrl = () =>
    `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-home-'));
    received = [];
    status = 201;
    api = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => {
        if (request.url === '/api/runner/runs') {
          received.push({
            auth: request.headers.authorization,
            body: JSON.parse(text) as Record<string, unknown>,
          });
        }
        response.statusCode = status;
        response.end(
          JSON.stringify({ runId: 'srv-run', projectId: 'srv-project' }),
        );
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => api.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  it('reports the run once, with the project root and the run fields', async () => {
    const env = pairedEnv(apiUrl());
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out],
      project,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(received).toHaveLength(1);
    const [report] = received;
    expect(report?.auth).toBe('Bearer dfr_test');
    expect(report?.body).toMatchObject({
      rootPath: realpathSync.native(project),
      projectName: path.basename(project),
      scenarioName: JSON.parse(result.stdout).scenarioName,
      scenarioPath: 'demoflow/customers.demo.json',
      status: 'passed',
      formats: ['mp4'],
    });
    // Spec 192: the server's run id now names this run's directory here.
    const index = runnerPaths({
      platform: process.platform,
      env,
      homedir: home,
    }).reportedRuns;
    const lines = readFileSync(index, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        id: 'srv-run',
        runDir: path.resolve(JSON.parse(result.stdout).runDir),
        at: expect.any(String),
        // Spec 225: what the MCP tools build the run's page URL from.
        projectId: 'srv-project',
        server: apiUrl(),
        // Spec 248: the root it sent registers the project on this machine.
        root: realpathSync.native(project),
      },
    ]);
  });

  it('sends no report with DEMOFLOW_NO_REPORT=1', async () => {
    const env = { ...pairedEnv(apiUrl()), DEMOFLOW_NO_REPORT: '1' };
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out],
      project,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('keeps the output and the exit code when the API answers 500', async () => {
    status = 500;
    const env = pairedEnv(apiUrl());
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out],
      project,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(result.stderr).not.toMatch(/report|500|runner\/runs/i);
    const index = runnerPaths({
      platform: process.platform,
      env,
      homedir: home,
    }).reportedRuns;
    expect(existsSync(index)).toBe(false);
  });

  it('keeps the output and the exit code when the API is unreachable', async () => {
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out],
      project,
      pairedEnv('http://127.0.0.1:1'),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
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

  it('renders with render.frame and render.background from demoflow.config.json', async () => {
    const framed = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-framed-'));
    try {
      const colour = [0xc0, 0x30, 0x20];
      await writeFile(
        path.join(framed, 'demoflow.config.json'),
        JSON.stringify({
          baseUrl: fixture.origin,
          render: {
            frame: { marginRatio: 0.2 },
            background: { color: '#c03020' },
            // Frame 0 is the page, not the intro card nor the first load's
            // background (spec 114).
            cards: { intro: { enabled: false } },
            transitions: { enabled: false },
          },
        }),
      );
      await cp(FIXTURE_SCENARIOS, path.join(framed, 'demoflow'), {
        recursive: true,
      });
      const result = await demoflow(
        [
          'run',
          path.join(framed, 'demoflow', 'customers.demo.json'),
          '--json',
          '--out',
          out,
        ],
        framed,
      );
      expect(result.code, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout);
      const { stdout: frame } = await runFfmpegRaw([
        '-i',
        path.join(json.runDir, json.renders[0].file),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
      expect(frame.length).toBe(1920 * 1080 * 3);
      // The corner is background either way; with a 20 % margin the window
      // starts 216 px down, so (960, 150) is background too — with the
      // default 6 % it would be the page.
      for (const [x, y] of [
        [5, 5],
        [960, 150],
      ]) {
        const at = (y * 1920 + x) * 3;
        const pixel = [frame[at], frame[at + 1], frame[at + 2]];
        pixel.forEach((value, c) => {
          expect(
            Math.abs(value - colour[c]),
            `(${x}, ${y}) is ${pixel}`,
          ).toBeLessThanOrEqual(8);
        });
      }
    } finally {
      await rm(framed, { recursive: true, force: true });
    }
  });

  it('renders the cards from render.cards: the intro card opens the video', async () => {
    const carded = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-cards-'));
    try {
      const render = async (cards: object): Promise<string> => {
        await writeFile(
          path.join(carded, 'demoflow.config.json'),
          JSON.stringify({
            baseUrl: fixture.origin,
            render: { background: { color: '#c03020' }, cards },
          }),
        );
        const result = await demoflow(
          [
            'run',
            path.join(carded, 'demoflow', 'customers.demo.json'),
            '--json',
            '--out',
            out,
          ],
          carded,
        );
        expect(result.code, result.stderr).toBe(0);
        const json = JSON.parse(result.stdout);
        return path.join(json.runDir, json.renders[0].file);
      };
      await cp(FIXTURE_SCENARIOS, path.join(carded, 'demoflow'), {
        recursive: true,
      });
      const file = await render({ outro: { title: 'Acme' } });
      const { stdout: frame } = await runFfmpegRaw([
        '-i',
        file,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
      expect(frame.length).toBe(1920 * 1080 * 3);
      const pixel = (x: number, y: number): number[] => {
        const at = (y * 1920 + x) * 3;
        return [frame[at], frame[at + 1], frame[at + 2]];
      };
      // The intro card: background where the window would be at 6 % margin…
      const colour = [0xc0, 0x30, 0x20];
      pixel(960, 150).forEach((value, c) => {
        expect(Math.abs(value - colour[c])).toBeLessThanOrEqual(8);
      });
      // …and the scenario name in white across the middle.
      let white = 0;
      for (let y = 480; y < 560; y++) {
        for (let x = 0; x < 1920; x++) {
          if (pixel(x, y).every((value) => value > 220)) white++;
        }
      }
      expect(white).toBeGreaterThan(200);
    } finally {
      await rm(carded, { recursive: true, force: true });
    }
  });

  it('renders with render.transitions on by default: the first load opens on the background', async () => {
    const faded = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-fades-'));
    try {
      await writeFile(
        path.join(faded, 'demoflow.config.json'),
        JSON.stringify({
          baseUrl: fixture.origin,
          render: {
            background: { color: '#c03020' },
            cards: { intro: { enabled: false } },
          },
        }),
      );
      await cp(FIXTURE_SCENARIOS, path.join(faded, 'demoflow'), {
        recursive: true,
      });
      const result = await demoflow(
        [
          'run',
          path.join(faded, 'demoflow', 'customers.demo.json'),
          '--json',
          '--out',
          out,
        ],
        faded,
      );
      expect(result.code, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout);
      const { stdout: frame } = await runFfmpegRaw([
        '-i',
        path.join(json.runDir, json.renders[0].file),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
      expect(frame.length).toBe(1920 * 1080 * 3);
      // The middle of the window: the background, not about:blank's white
      // nor the page — the page dissolves in once it has loaded (spec 114).
      const colour = [0xc0, 0x30, 0x20];
      const at = (540 * 1920 + 960) * 3;
      const pixel = [frame[at], frame[at + 1], frame[at + 2]];
      pixel.forEach((value, c) => {
        expect(Math.abs(value - colour[c]), `${pixel}`).toBeLessThanOrEqual(8);
      });
    } finally {
      await rm(faded, { recursive: true, force: true });
    }
  });

  it('runs a repeat once per item: five customers typed, each event tagged', async () => {
    const result = await demoflow(
      ['run', scenario('customers-repeat'), '--json', '--out', out],
      project,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.status).toBe('completed');
    const timeline = JSON.parse(
      await readFile(path.join(json.runDir, 'timeline.json'), 'utf8'),
    );
    // navigate, the repeat's caption, then 5 steps × 5 customers.
    expect(timeline.events).toHaveLength(27);
    expect(timeline.events[1]).toMatchObject({
      action: 'marker',
      origin: { repeatIndex: 1, iteration: 0 },
    });
    const names = timeline.events.filter(
      (event: { action: string; value?: string }) =>
        event.action === 'fill' && !event.value?.includes('@'),
    );
    expect(names.map((event: { value: string }) => event.value)).toEqual([
      'Grace Hopper',
      'Alan Turing',
      'Edsger Dijkstra',
      'Barbara Liskov',
      'Ken Thompson',
    ]);
    expect(timeline.events.at(-1).origin).toEqual({
      repeatIndex: 1,
      iteration: 4,
    });
  });

  it('a failing scenario exits 1 with status failed', async () => {
    const result = await demoflow(
      ['run', scenario('failing'), '--json', '--out', out],
      project,
    );
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('failed');
  });

  it('--format gif renders only the GIF, whatever render.formats says', async () => {
    const result = await demoflow(
      ['run', scenario('customers'), '--json', '--out', out, '--format', 'gif'],
      project,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.renders).toHaveLength(1);
    expect(json.renders[0]).toMatchObject({
      format: 'gif',
      file: 'render/ffmpeg.gif',
      width: 800,
      height: 450,
      fps: 12,
    });
    expect(await exists(path.join(json.runDir, 'render/ffmpeg.gif'))).toBe(
      true,
    );
    expect(await exists(path.join(json.runDir, 'render/ffmpeg.mp4'))).toBe(
      false,
    );
  });

  it('--format with an unknown or repeated format is a usage error before any run', async () => {
    for (const formats of [['avi'], ['gif', 'gif']]) {
      const isolated = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-fmt-'));
      try {
        const result = await demoflow(
          [
            'run',
            scenario('customers'),
            '--out',
            isolated,
            ...formats.flatMap((format) => ['--format', format]),
          ],
          project,
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('--format');
        // Nothing ran: no run directory, so no browser and no app.
        expect(await exists(path.join(isolated, 'runs'))).toBe(false);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    }
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

  it('--base-url on another origin than baseUrl passes readiness: allowedOrigins follows it (spec 337)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-base-url-'));
    try {
      await writeFile(
        path.join(dir, 'demoflow.config.json'),
        JSON.stringify({ baseUrl: 'http://localhost:3000' }),
      );
      await cp(FIXTURE_SCENARIOS, path.join(dir, 'demoflow'), {
        recursive: true,
      });
      const result = await demoflow(
        [
          'run',
          path.join(dir, 'demoflow/customers.demo.json'),
          '--json',
          '--base-url',
          fixture.origin,
          '--out',
          out,
        ],
        dir,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe('completed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe('demoflow run starts the app from devCommand', () => {
  /** A project whose config carries `devCommand`; the scenarios run against the fixture. */
  async function projectWith(
    devCommand: Record<string, unknown>,
  ): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-dev-'));
    await writeFile(
      path.join(dir, 'demoflow.config.json'),
      JSON.stringify({ baseUrl: fixture.origin, devCommand }),
    );
    await cp(FIXTURE_SCENARIOS, path.join(dir, 'demoflow'), {
      recursive: true,
    });
    return dir;
  }

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** `node -e`: records its pid in `marker`, then listens on `port` after `delayMs`. */
  const appScript = (port: number, marker: string, delayMs = 0) => ({
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
       setTimeout(() => require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'), ${delayMs})`,
    ],
  });

  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  const track = async (devCommand: Record<string, unknown>) => {
    const dir = await projectWith(devCommand);
    dirs.push(dir);
    return dir;
  };

  it('starts the app, waits for readyUrl, runs and stops the process afterwards', async () => {
    const port = await freePort();
    const marker = path.join(out, `app-${port}.pid`);
    const dir = await track({
      ...appScript(port, marker, 500),
      readyUrl: `http://127.0.0.1:${port}/`,
    });
    const result = await demoflow(
      [
        'run',
        path.join(dir, 'demoflow/customers.demo.json'),
        '--json',
        '--out',
        out,
      ],
      dir,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout).status).toBe('completed');
    const pid = Number(await readFile(marker, 'utf8'));
    expect(alive(pid)).toBe(false);
  });

  it('starts nothing when readyUrl already answers', async () => {
    const marker = path.join(out, 'never-started.pid');
    const dir = await track({
      ...appScript(1, marker),
      readyUrl: `${fixture.origin}/`,
    });
    const result = await demoflow(
      [
        'run',
        path.join(dir, 'demoflow/customers.demo.json'),
        '--json',
        '--out',
        out,
      ],
      dir,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(await exists(marker)).toBe(false);
  });

  it('a devCommand that never becomes ready fails readiness with its last output, exit 2, nothing left behind', async () => {
    const marker = path.join(out, 'never-ready.pid');
    const dir = await track({
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
         for (let i = 1; i <= 30; i++) console.log('app line ' + i);
         setInterval(() => {}, 1000)`,
      ],
      readyUrl: `http://127.0.0.1:${await freePort()}/`,
      timeoutMs: 1500,
    });
    const result = await demoflow(
      [
        'run',
        path.join(dir, 'demoflow/customers.demo.json'),
        '--json',
        '--out',
        out,
      ],
      dir,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const json = JSON.parse(result.stdout);
    expect(json.status).toBe('failed');
    expect(json.stages.readiness.status).toBe('failed');
    const message: string = json.stages.readiness.error.message;
    expect(message).toContain('did not answer');
    expect(message).toContain('app line 30');
    expect(message).toContain('app line 11');
    expect(message).not.toContain('app line 10\n');
    expect(json.stages.execution.status).toBe('skipped');
    expect(json.stages.rendering.status).toBe('skipped');
    expect(alive(Number(await readFile(marker, 'utf8')))).toBe(false);
  });

  it('--port without ${PORT} in the config warns once and still sets PORT for the app', async () => {
    const port = await freePort();
    const marker = path.join(out, `app-env-${port}.txt`);
    const dir = await track({
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.env.PORT));
         require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')`,
      ],
      readyUrl: `http://127.0.0.1:${port}/`,
    });
    const result = await demoflow(
      [
        'run',
        path.join(dir, 'demoflow/customers.demo.json'),
        '--json',
        '--port',
        String(port),
        '--out',
        out,
      ],
      dir,
    );
    expect(result.code, result.stderr).toBe(0);
    const warning = `warning: --port ${port} is given but demoflow.config.json uses no \${PORT}; baseUrl and readyUrl are unchanged`;
    expect(result.stderr.split(warning)).toHaveLength(2);
    expect(await readFile(marker, 'utf8')).toBe(String(port));
  });

  it('--fresh-app exits 2 fast when readyUrl already answers, with nothing started or written', async () => {
    const holder = createServer((_, response) => response.end('someone else'));
    await new Promise<void>((resolve) =>
      holder.listen(0, '127.0.0.1', resolve),
    );
    const { port } = holder.address() as AddressInfo;
    try {
      const dir = await mkdtemp(path.join(tmpdir(), 'demoflow-cli-fresh-'));
      dirs.push(dir);
      await writeFile(
        path.join(dir, 'demoflow.config.json'),
        JSON.stringify({
          baseUrl: 'http://127.0.0.1:${PORT}',
          devCommand: {
            command: 'demoflow-no-such-command',
            readyUrl: '${BASE_URL}/',
          },
        }),
      );
      // No scenario warning: stderr is the refusal alone.
      await writeFile(
        path.join(dir, 'a.demo.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: 'A',
          steps: [{ action: 'navigate', path: '/' }],
        }),
      );
      const started = performance.now();
      const result = await demoflow(
        [
          'run',
          path.join(dir, 'a.demo.json'),
          '--json',
          '--port',
          String(port),
          '--fresh-app',
          '--run-id',
          'fresh-refused',
          '--out',
          out,
        ],
        dir,
      );
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        new RegExp(
          `^app-already-running: --fresh-app: http://127\\.0\\.0\\.1:${port}/ already answers`,
        ),
      );
      expect(await exists(path.join(out, 'runs', 'fresh-refused'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe('two runs in parallel, each on its own port (spec 337)', () => {
  // Listens on the port of its --port argument and names its checkout, so a
  // video of the wrong app cannot pass the scenario.
  const SERVER = `import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const here = new URL('.', import.meta.url);
const name = readFileSync(new URL('name.txt', here), 'utf8').trim();
const port = process.argv[process.argv.indexOf('--port') + 1];
writeFileSync(new URL('server.pid', here), String(process.pid));
createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>' + name + '</title><h1>checkout ' + name + ' port ' + port + ' env ' + process.env.PORT + '</h1>');
}).listen(Number(port), '127.0.0.1');
`;

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  async function checkout(name: string, port: number): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), `demoflow-cli-${name}-`));
    await writeFile(path.join(dir, 'server.mjs'), SERVER);
    await writeFile(path.join(dir, 'name.txt'), name);
    await writeFile(
      path.join(dir, 'demoflow.config.json'),
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:${PORT}',
        devCommand: {
          command: process.execPath,
          args: ['server.mjs', '--port', '${PORT}'],
          readyUrl: '${BASE_URL}/',
        },
      }),
    );
    const heading = { role: 'heading' };
    await writeFile(
      path.join(dir, 'own.demo.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: `Checkout ${name}`,
        steps: [
          { action: 'navigate', path: '/' },
          {
            action: 'assertText',
            target: heading,
            text: `checkout ${name} port ${port}`,
          },
          { action: 'assertText', target: heading, text: `env ${port}` },
        ],
      }),
    );
    return dir;
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('--port A and --port B in two checkouts start their own app and record their own page', async () => {
    const portA = await freePort();
    let portB = await freePort();
    while (portB === portA) portB = await freePort();
    const a = await checkout('A', portA);
    const b = await checkout('B', portB);
    dirs.push(a, b);
    const run = (dir: string, port: number) =>
      demoflow(
        [
          'run',
          path.join(dir, 'own.demo.json'),
          '--json',
          '--port',
          String(port),
          '--out',
          path.join(dir, 'out'),
        ],
        dir,
      );
    const [resultA, resultB] = await Promise.all([
      run(a, portA),
      run(b, portB),
    ]);
    for (const [dir, result] of [
      [a, resultA],
      [b, resultB],
    ] as const) {
      expect(result.code, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.status).toBe('completed');
      const mp4 = json.renders.find(
        (render: { format: string }) => render.format === 'mp4',
      );
      expect(mp4).toBeDefined();
      expect(await exists(path.join(json.runDir, mp4.file))).toBe(true);
      const pid = Number(await readFile(path.join(dir, 'server.pid'), 'utf8'));
      expect(alive(pid)).toBe(false);
    }
  });
});
