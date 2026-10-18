import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../src/config/index.ts';
import { ToolError } from '../../src/mcp/errors.ts';
import {
  checkProject,
  listDemos,
  validateScenario,
} from '../../src/mcp/readonly.ts';

const FIXTURE_SCENARIOS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixture/demoflow',
);

let dir: string;
let project: string;
let home: string;
let host: HostEnvironment;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-mcp-ro-')));
  project = path.join(dir, 'project');
  home = path.join(dir, 'home');
  host = {
    platform: process.platform,
    env: { DEMOFLOW_HOME: home },
    homedir: path.join(dir, 'user'),
  };
  write('project/demoflow.config.json', '{"baseUrl":"http://localhost:1"}');
  for (const name of readdirSync(FIXTURE_SCENARIOS)) {
    write(
      `project/demoflow/${name}`,
      readFileSync(path.join(FIXTURE_SCENARIOS, name), 'utf8'),
    );
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

async function toolErrorAsync(fn: () => Promise<unknown>): Promise<ToolError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

describe('validate_scenario', () => {
  it('accepts every fixture scenario, by file', () => {
    const files = readdirSync(FIXTURE_SCENARIOS).filter((name) =>
      name.endsWith('.demo.json'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(
        validateScenario({ project, file: `demoflow/${name}` }, dir, host),
      ).toEqual({ valid: true });
    }
  });

  it('accepts a valid inline scenario', () => {
    const scenario = {
      schemaVersion: 1,
      name: 'Inline',
      steps: [{ action: 'navigate', path: '/customers' }],
    };
    expect(validateScenario({ project, scenario }, dir, host)).toEqual({
      valid: true,
    });
  });

  it('reports the issue paths of a broken inline scenario', () => {
    const error = toolError(() =>
      validateScenario(
        {
          project,
          scenario: {
            schemaVersion: 1,
            name: 'Broken',
            steps: [{ action: 'navigate' }],
          },
        },
        dir,
        host,
      ),
    );
    expect(error.code).toBe('invalid-scenario');
    expect(error.toPayload().issues?.map((issue) => issue.path)).toContain(
      'steps[0]',
    );
  });

  it('reports the issue paths of a broken file', () => {
    write(
      'project/demoflow/broken.demo.json',
      JSON.stringify({ schemaVersion: 1, name: 'Broken', steps: [{}] }),
    );
    const error = toolError(() =>
      validateScenario(
        { project, file: 'demoflow/broken.demo.json' },
        dir,
        host,
      ),
    );
    expect(error.code).toBe('invalid-scenario');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('wants exactly one of scenario and file', () => {
    expect(toolError(() => validateScenario({ project }, dir, host)).code).toBe(
      'both-or-neither-scenario',
    );
    expect(
      toolError(() =>
        validateScenario(
          { project, scenario: {}, file: 'demoflow/tour.demo.json' },
          dir,
          host,
        ),
      ).code,
    ).toBe('both-or-neither-scenario');
  });

  it('refuses a file outside the project', () => {
    write('outside.demo.json', '{}');
    expect(
      toolError(() =>
        validateScenario(
          { project, file: path.join(dir, 'outside.demo.json') },
          dir,
          host,
        ),
      ).code,
    ).toBe('file-not-in-project');
  });

  it('writes nothing: the project and home are unchanged', () => {
    const before = readdirSync(dir, { recursive: true }).map(String).sort();
    validateScenario({ project, file: 'demoflow/tour.demo.json' }, dir, host);
    expect(readdirSync(dir, { recursive: true }).map(String).sort()).toEqual(
      before,
    );
  });
});

function result(
  runId: string,
  startedAt: string,
  extra: { render?: boolean } = {},
): string {
  const stage = { status: 'passed' };
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    scenarioId: 'demoflow/tour.demo.json',
    scenarioName: `Scenario ${runId}`,
    startedAt,
    finishedAt: startedAt,
    status: 'completed',
    stages: {
      readiness: stage,
      execution: stage,
      verification: stage,
      recording: stage,
      rendering: stage,
      storage: stage,
    },
    renders:
      extra.render === true
        ? [
            {
              renderer: 'ffmpeg',
              file: 'demo.mp4',
              durationMs: 1234,
              sizeBytes: 10,
              width: 640,
              height: 360,
              fps: 30,
            },
          ]
        : [],
    warnings: [],
  });
}

describe('list_demos', () => {
  it('is empty when there are no runs', async () => {
    expect(await listDemos({ project }, dir, host)).toEqual({ demos: [] });
  });

  it('lists newest first, with duration and video when rendered', async () => {
    write(
      'home/runs/old/result.json',
      result('old', '2026-01-01T10:00:00.000Z'),
    );
    write(
      'home/runs/new/result.json',
      result('new', '2026-01-03T10:00:00.000Z', { render: true }),
    );
    write('home/runs/new/demo.mp4', 'x');
    write(
      'home/runs/mid/result.json',
      result('mid', '2026-01-02T10:00:00.000Z'),
    );

    const { demos } = await listDemos({ project }, dir, host);
    expect(demos.map((demo) => demo.taskId)).toEqual(['new', 'mid', 'old']);
    expect(demos[0]).toEqual({
      taskId: 'new',
      scenarioName: 'Scenario new',
      status: 'completed',
      startedAt: '2026-01-03T10:00:00.000Z',
      durationMs: 1234,
      video: path.join(home, 'runs', 'new', 'demo.mp4'),
    });
    expect(demos[1]).not.toHaveProperty('video');
    expect(demos[1]).not.toHaveProperty('durationMs');
  });

  it('honours limit', async () => {
    for (let day = 1; day <= 5; day += 1) {
      write(
        `home/runs/r${day}/result.json`,
        result(`r${day}`, `2026-01-0${day}T10:00:00.000Z`),
      );
    }
    const { demos } = await listDemos({ project, limit: 2 }, dir, host);
    expect(demos.map((demo) => demo.taskId)).toEqual(['r5', 'r4']);
  });

  it('skips a corrupt, invalid or missing result.json', async () => {
    write(
      'home/runs/good/result.json',
      result('good', '2026-01-01T10:00:00.000Z'),
    );
    write('home/runs/corrupt/result.json', '{ not json');
    write('home/runs/invalid/result.json', '{"schemaVersion":1}');
    mkdirSync(path.join(home, 'runs', 'empty'), { recursive: true });
    write('home/runs/stray-file', 'x');

    const { demos } = await listDemos({ project }, dir, host);
    expect(demos.map((demo) => demo.taskId)).toEqual(['good']);
  });

  it("lists only the given project's home", async () => {
    const other = path.join(dir, 'other');
    // `DEMOFLOW_HOME` outranks a project's `artifactsDir`: the other project is asked without it.
    const otherHost = { ...host, env: {} };
    write(
      'other-home/runs/theirs/result.json',
      result('theirs', '2026-01-01T10:00:00.000Z'),
    );
    write(
      'home/runs/mine/result.json',
      result('mine', '2026-01-01T10:00:00.000Z'),
    );
    write(
      'other/demoflow.config.json',
      JSON.stringify({
        baseUrl: 'http://localhost:1',
        artifactsDir: path.join(dir, 'other-home'),
      }),
    );

    expect(
      (await listDemos({ project: other }, dir, otherHost)).demos.map(
        (demo) => demo.taskId,
      ),
    ).toEqual(['theirs']);
    expect(
      (await listDemos({ project }, dir, host)).demos.map(
        (demo) => demo.taskId,
      ),
    ).toEqual(['mine']);
  });
});

describe('check_project', () => {
  it("reports the fixture's scenarios, FFmpeg and browser", async () => {
    const check = await checkProject({ project }, dir, host);
    expect(check.root).toBe(project);
    expect(check.configValid).toBe(true);
    expect(check.scenarios).toEqual(
      readdirSync(FIXTURE_SCENARIOS)
        .filter((name) => name.endsWith('.demo.json'))
        .map((name) => `demoflow/${name}`)
        .sort(),
    );
    expect(['system', 'bundled', 'missing']).toContain(check.ffmpeg);
    expect(['installed', 'missing']).toContain(check.browser);
  });

  it('finds scenarios in subdirectories with / separators', async () => {
    write('project/demoflow/nested/deep/a.demo.json', '{}');
    write('project/demoflow/nested/readme.md', '');
    const { scenarios } = await checkProject({ project }, dir, host);
    expect(scenarios).toContain('demoflow/nested/deep/a.demo.json');
    expect(scenarios.some((name) => name.endsWith('.md'))).toBe(false);
  });

  it('has no scenarios without a demoflow directory', async () => {
    rmSync(path.join(project, 'demoflow'), { recursive: true });
    expect((await checkProject({ project }, dir, host)).scenarios).toEqual([]);
  });

  it('is project-not-found without demoflow.config.json', async () => {
    const bare = path.join(dir, 'bare');
    mkdirSync(bare);
    const error = await toolErrorAsync(() =>
      checkProject({ project: bare }, dir, host),
    );
    expect(error.code).toBe('project-not-found');
  });
});
