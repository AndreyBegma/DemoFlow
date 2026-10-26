import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveRunStatus, type RunResult } from '@demoflow/core';
import type {
  Renderer,
  RenderPlan,
  RenderPlanOptions,
} from '@demoflow/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '../../src/commands/errors.ts';
import type { Io } from '../../src/commands/io.ts';
import {
  type RenderDeps,
  type RenderFlags,
  renderCommand,
} from '../../src/commands/render.ts';
import { PROJECT_CONFIG_FILE } from '../../src/config/index.ts';
import { main } from '../../src/main.ts';

const RUN_ID = '20261023-101500-abcdef';
const PLAN = { output: { files: [] } } as unknown as RenderPlan;

type StageStatus = RunResult['stages']['readiness']['status'];

let project: string;
let home: string;
let runDir: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'demoflow-render-'));
  home = path.join(project, 'artifacts');
  runDir = path.join(home, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(project, PROJECT_CONFIG_FILE),
    JSON.stringify({
      baseUrl: 'http://localhost:3680',
      artifactsDir: 'artifacts',
      render: { formats: ['mp4', 'webm'], fps: 24 },
    }),
  );
  await mkdir(path.join(project, 'demoflow'));
  await writeFile(
    path.join(project, 'demoflow/login.demo.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Sign in',
      description: 'Sign in with a password.',
      steps: [{ action: 'navigate', path: '/login' }],
    }),
  );
  await writeFile(path.join(runDir, 'timeline.json'), '{}\n');
  await writeFile(path.join(runDir, 'source.webm'), '');
  await writeResult(result());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

function result(
  overrides: Partial<Record<keyof RunResult['stages'], StageStatus>> = {},
): RunResult {
  const stage = (name: keyof RunResult['stages'], fallback: StageStatus) => {
    const status = overrides[name] ?? fallback;
    return status === 'failed'
      ? {
          status,
          startedAt: '2026-10-23T10:15:01.000Z',
          finishedAt: '2026-10-23T10:15:02.000Z',
          error: { message: `${name} broke`, stepIndex: 0 },
        }
      : { status };
  };
  const stages = {
    readiness: stage('readiness', 'passed'),
    execution: stage('execution', 'passed'),
    verification: stage('verification', 'passed'),
    recording: stage('recording', 'passed'),
    rendering: stage('rendering', 'passed'),
    storage: stage('storage', 'skipped'),
  };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    scenarioId: 'demoflow/login.demo.json',
    scenarioName: 'Sign in',
    startedAt: '2026-10-23T10:15:00.000Z',
    finishedAt: '2026-10-23T10:15:05.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [
      {
        renderer: 'ffmpeg',
        format: 'mp4',
        file: 'render/ffmpeg.mp4',
        durationMs: 4000,
        sizeBytes: 1000,
        width: 1280,
        height: 720,
        fps: 30,
      },
    ],
    warnings: [],
  };
}

async function writeResult(value: RunResult): Promise<void> {
  await writeFile(
    path.join(runDir, 'result.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function readResultFile(): Promise<RunResult> {
  return JSON.parse(
    await readFile(path.join(runDir, 'result.json'), 'utf8'),
  ) as RunResult;
}

/** Writes what `recordRender` would: one GIF entry, `rendering` passed. */
function fakeRenderer(): Renderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'ffmpeg',
    calls,
    async render(dir) {
      calls.push(dir);
      const current = JSON.parse(
        await readFile(path.join(dir, 'result.json'), 'utf8'),
      ) as RunResult;
      const output = {
        renderer: 'ffmpeg',
        format: 'gif' as const,
        file: 'render/ffmpeg.gif',
        durationMs: 3800,
        sizeBytes: 500,
        width: 800,
        height: 450,
        fps: 12,
      };
      current.renders = [output];
      current.stages.rendering = {
        status: 'passed',
        startedAt: '2026-10-23T11:00:00.000Z',
        finishedAt: '2026-10-23T11:00:01.000Z',
      };
      current.status = deriveRunStatus(current.stages, current.warnings);
      await writeFile(
        path.join(dir, 'result.json'),
        `${JSON.stringify(current, null, 2)}\n`,
      );
      return [output];
    },
  };
}

function capture(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

function deps(overrides: Partial<RenderDeps> = {}): RenderDeps & {
  plans: { dir: string; options: RenderPlanOptions }[];
} {
  const plans: { dir: string; options: RenderPlanOptions }[] = [];
  return {
    host: {
      platform: process.platform,
      env: { XDG_CONFIG_HOME: project, APPDATA: project },
      homedir: project,
    },
    cwd: project,
    buildPlan: async (dir, options = {}) => {
      plans.push({ dir, options });
      return PLAN;
    },
    renderer: fakeRenderer(),
    plans,
    ...overrides,
  };
}

function render(
  flags: RenderFlags = {},
  overrides: Partial<RenderDeps> = {},
  runId = RUN_ID,
) {
  const io = capture();
  const d = deps(overrides);
  return renderCommand(runId, flags, io, d).then((code) => ({
    code,
    io,
    deps: d,
  }));
}

describe('demoflow render', () => {
  it('re-renders a finished run with the current render config', async () => {
    const { code, io, deps: d } = await render();

    expect(code).toBe(0);
    expect(d.plans).toHaveLength(1);
    expect(d.plans[0]?.dir).toBe(runDir);
    expect(d.plans[0]?.options.formats).toEqual(['mp4', 'webm']);
    expect(d.plans[0]?.options.output?.fps).toBe(24);
    // The default end hold, as `demoflow run` recorded it (spec 365).
    expect(d.plans[0]?.options.endHoldMs).toBe(3500);
    expect(io.err).toContain('Rendering\n');
    expect(io.out).toContain(RUN_ID);
    const written = await readResultFile();
    expect(written.renders.map((entry) => entry.format)).toEqual(['gif']);
    expect(written.status).toBe('completed');
  });

  it('--format replaces render.formats; the renderer is called once', async () => {
    const renderer = fakeRenderer();
    const { deps: d } = await render({ format: ['gif'] }, { renderer });

    expect(d.plans[0]?.options.formats).toEqual(['gif']);
    expect(renderer.calls).toEqual([runDir]);
  });

  it('--json prints one JSON object on stdout', async () => {
    const { code, io } = await render({ json: true });

    expect(code).toBe(0);
    const printed = JSON.parse(io.out) as { runId: string; status: string };
    expect(printed.runId).toBe(RUN_ID);
    expect(printed.status).toBe('completed');
  });

  it('--out names the home instead of the project config', async () => {
    const other = path.join(project, 'elsewhere');

    await expect(render({ out: other })).rejects.toMatchObject({
      code: 'run-not-found',
    });
  });

  it('a failed run stays failed and its other stages are unchanged', async () => {
    await writeResult(result({ verification: 'failed' }));
    const before = await readResultFile();

    const { code } = await render();

    const after = await readResultFile();
    expect(code).toBe(1);
    expect(after.status).toBe('failed');
    for (const stage of [
      'readiness',
      'execution',
      'verification',
      'recording',
      'storage',
    ] as const) {
      expect(JSON.stringify(after.stages[stage])).toBe(
        JSON.stringify(before.stages[stage]),
      );
    }
    expect(after.renders.map((entry) => entry.format)).toEqual(['gif']);
  });

  it('retries a render left running by a crash', async () => {
    await writeResult(result({ rendering: 'running' }));

    const { code } = await render();

    expect(code).toBe(0);
    expect((await readResultFile()).stages.rendering.status).toBe('passed');
  });

  it('passes the scenario description to the plan when the file exists', async () => {
    const { deps: d } = await render();

    expect(d.plans[0]?.options.scenario).toEqual({
      description: 'Sign in with a password.',
    });
  });

  it('renders without a subtitle when the scenario file is gone', async () => {
    await rm(path.join(project, 'demoflow/login.demo.json'));

    const { code, deps: d } = await render();

    expect(code).toBe(0);
    expect(d.plans[0]?.options.scenario).toEqual({});
  });

  it('a renderer that rejects exits 3 with rendering failed on stderr', async () => {
    const renderer: Renderer = {
      name: 'ffmpeg',
      render: () => Promise.reject(new Error('ffmpeg exited 1')),
    };

    const { code, io } = await render({}, { renderer });

    expect(code).toBe(3);
    expect(io.err).toContain('rendering failed: ffmpeg exited 1');
  });

  it('makes no HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await render();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('refusals: exit 2, result.json unchanged, nothing rendered', () => {
    async function expectRefused(
      code: string,
      flags: RenderFlags = {},
      runId = RUN_ID,
    ): Promise<void> {
      const before = await readFile(path.join(runDir, 'result.json'), 'utf8');
      const renderer = fakeRenderer();
      const error = await render(flags, { renderer }, runId).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ code, exitCode: 2 });
      expect(renderer.calls).toEqual([]);
      const after = await readFile(path.join(runDir, 'result.json'), 'utf8');
      expect(after).toBe(before);
    }

    it('an unsafe run id', async () => {
      await expectRefused('invalid-run-id', {}, '../runs');
    });

    it('a missing run directory', async () => {
      await expectRefused('run-not-found', {}, '20261023-000000-zzzzzz');
    });

    it('an unreadable result.json', async () => {
      await writeFile(path.join(runDir, 'result.json'), '{ "schemaVersion": 1');
      await expectRefused('invalid-result');
    });

    it('a result.json that fails the schema', async () => {
      await writeFile(path.join(runDir, 'result.json'), '{"status":"done"}\n');
      await expectRefused('invalid-result');
    });

    it.each([
      'readiness',
      'execution',
      'verification',
      'recording',
    ] as const)('a run whose %s is still running', async (stage) => {
      await writeResult(result({ [stage]: 'running' }));
      await expectRefused('run-unfinished');
    });

    it('a run whose recording is pending', async () => {
      await writeResult(result({ recording: 'pending' }));
      await expectRefused('run-unfinished');
    });

    it('a run whose recording was skipped', async () => {
      await writeResult(result({ execution: 'failed', recording: 'skipped' }));
      await expectRefused('no-recording');
    });

    it('a run without its source video', async () => {
      await rm(path.join(runDir, 'source.webm'));
      await expectRefused('no-recording');
    });
  });
});

describe('demoflow render --help', () => {
  it('lists the flags and hides --project', async () => {
    const io = capture();

    const code = await main(['render', '--help'], io);

    expect(code).toBe(0);
    expect(io.out).toContain('<runId>');
    expect(io.out).toContain('--format <format>');
    expect(io.out).toContain('--out <dir>');
    expect(io.out).toContain('--json');
    expect(io.out).not.toContain('--project');
  });
});
