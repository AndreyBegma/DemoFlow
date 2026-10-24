// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCommand } from '../../src/commands/check.ts';
import type { Io } from '../../src/commands/io.ts';
import { listCommand } from '../../src/commands/list.ts';
import type { HostEnvironment } from '../../src/config/index.ts';
import { main } from '../../src/main.ts';
import { checkProject, listDemos } from '../../src/mcp/readonly.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';

let dir: string;
let project: string;
let home: string;
let host: HostEnvironment;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-list-check-')));
  project = path.join(dir, 'project');
  home = path.join(dir, 'home');
  host = {
    platform: process.platform,
    env: { DEMOFLOW_HOME: home },
    homedir: path.join(dir, 'user'),
  };
  write('project/demoflow.config.json', '{"baseUrl":"http://localhost:1"}');
  write('project/demoflow/login.demo.json', '{}');
  write('project/demoflow/nested/tour.demo.json', '{}');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
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

function result(runId: string, startedAt: string, durationMs?: number): string {
  const stage = { status: 'passed' };
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    scenarioId: 'demoflow/login.demo.json',
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
      durationMs === undefined
        ? []
        : [
            {
              renderer: 'ffmpeg',
              format: 'mp4',
              file: 'render/ffmpeg.mp4',
              durationMs,
              sizeBytes: 10,
              width: 640,
              height: 360,
              fps: 30,
            },
          ],
    warnings: [],
  });
}

function seedRuns(): void {
  write('home/runs/old/result.json', result('old', '2026-01-01T10:00:00.000Z'));
  write(
    'home/runs/new/result.json',
    result('new', '2026-01-03T10:00:00.000Z', 4000),
  );
  write('home/runs/corrupt/result.json', '{ not json');
  appendReportedRun(runnerPaths(host).reportedRuns, {
    id: 'srv 1',
    runDir: path.join(home, 'runs', 'new'),
    at: '2026-01-03T10:01:00.000Z',
    projectId: 'p1',
    server: 'https://demoflow.example',
  });
}

describe('a config with ${PORT} and PORT unset (spec 337)', () => {
  beforeEach(() => {
    vi.stubEnv('PORT', '');
    write(
      'project/demoflow.config.json',
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:${PORT}',
        devCommand: {
          command: 'node',
          args: ['server.mjs', '--port', '${PORT}'],
          readyUrl: '${BASE_URL}/',
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('demoflow check reports the config valid', async () => {
    const io = capture();
    const code = await checkCommand({}, io, {
      host,
      cwd: project,
      check: async (input, cwd, env) => ({
        ...(await checkProject(input, cwd, env)),
        ffmpeg: 'bundled',
        browser: 'installed',
      }),
    });
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('config: valid');
  });

  it('demoflow list lists the runs', async () => {
    seedRuns();
    const io = capture();
    expect(await listCommand({}, io, { host, cwd: project })).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('Scenario new');
  });
});

describe('demoflow list', () => {
  it('prints runs newest first, skips a corrupt one, shows the page URL', async () => {
    seedRuns();
    const io = capture();
    const code = await listCommand({}, io, { host, cwd: project });
    expect(code).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^completed {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}4\.0s {2}Scenario new {2}new$/,
    );
    expect(lines[1]).toBe(
      '  https://demoflow.example/app/projects/p1/runs/srv%201',
    );
    expect(lines[2]).toMatch(/ {2}- {2}Scenario old {2}old$/);
    expect(io.err).toBe('');
  });

  it('--json prints exactly what listDemos returns', async () => {
    seedRuns();
    const io = capture();
    const code = await listCommand({ json: true }, io, { host, cwd: project });
    expect(code).toBe(0);
    expect(io.out).toBe(
      `${JSON.stringify(await listDemos({ project }, project, host))}\n`,
    );
  });

  it('--limit 1 returns one run', async () => {
    seedRuns();
    const io = capture();
    await listCommand({ limit: '1', json: true }, io, { host, cwd: project });
    const { demos } = JSON.parse(io.out) as { demos: { taskId: string }[] };
    expect(demos.map((demo) => demo.taskId)).toEqual(['new']);
  });

  it.each([
    '0',
    '101',
    'x',
    '1.5',
    '-1',
  ])('rejects --limit %s with exit 2 and invalid-limit', async (limit) => {
    const io = capture();
    expect(await main(['list', '--limit', limit], io)).toBe(2);
    expect(io.err).toContain('invalid-limit');
    expect(io.out).toBe('');
  });

  it('says so when there are no runs', async () => {
    const io = capture();
    const code = await listCommand({}, io, { host, cwd: project });
    expect(code).toBe(0);
    expect(io.out).toBe(`No runs yet in ${path.join(home, 'runs')}.\n`);
  });

  it('exits 2 with the message and hint outside a project', async () => {
    for (const json of [false, true]) {
      const io = capture();
      const code = await listCommand({ json }, io, { host, cwd: dir });
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('demoflow.config.json');
      expect(io.err).toContain('hint:');
    }
  });

  it('--project accepts a relative directory', async () => {
    seedRuns();
    const io = capture();
    const code = await listCommand({ project: 'project', json: true }, io, {
      host,
      cwd: dir,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.out).demos).toHaveLength(2);
  });

  it('--help lists the flags', async () => {
    const io = capture();
    expect(await main(['list', '--help'], io)).toBe(0);
    expect(io.out).toContain('--limit <n>');
    expect(io.out).toContain('--json');
  });
});

describe('demoflow check', () => {
  const ready = (
    ffmpeg: 'system' | 'bundled' | 'missing',
    browser: 'installed' | 'missing',
  ): typeof checkProject => {
    return async (input, cwd, env) => ({
      ...(await checkProject(input, cwd, env)),
      ffmpeg,
      browser,
    });
  };

  it('exits 0 and prints the report when everything is available', async () => {
    const io = capture();
    const code = await checkCommand({}, io, {
      host,
      cwd: project,
      check: ready('bundled', 'installed'),
    });
    expect(code).toBe(0);
    expect(io.out).toBe(
      [
        `root: ${project}`,
        'config: valid',
        'scenarios:',
        '  demoflow/login.demo.json',
        '  demoflow/nested/tour.demo.json',
        'ffmpeg: bundled',
        'browser: installed',
        '',
      ].join('\n'),
    );
  });

  it('lists "none" for a project without scenarios', async () => {
    rmSync(path.join(project, 'demoflow'), { recursive: true });
    const io = capture();
    await checkCommand({}, io, {
      host,
      cwd: project,
      check: ready('system', 'installed'),
    });
    expect(io.out).toContain('scenarios:\n  none\n');
  });

  it('exits 1 with the setup hint when the browser is missing', async () => {
    const io = capture();
    const code = await checkCommand({}, io, {
      host,
      cwd: project,
      check: ready('system', 'missing'),
    });
    expect(code).toBe(1);
    expect(io.out).toContain('browser: missing');
    expect(io.out).toContain('run demoflow setup');
  });

  it('exits 1 when FFmpeg is missing', async () => {
    const io = capture();
    const code = await checkCommand({}, io, {
      host,
      cwd: project,
      check: ready('missing', 'installed'),
    });
    expect(code).toBe(1);
    expect(io.out).toContain('ffmpeg: missing');
    expect(io.out).not.toContain('demoflow setup');
  });

  it('--json prints exactly the check object, whatever the exit code', async () => {
    const check = ready('missing', 'missing');
    const io = capture();
    const code = await checkCommand({ json: true }, io, {
      host,
      cwd: project,
      check,
    });
    expect(code).toBe(1);
    expect(io.out).toBe(`${JSON.stringify(await check({}, project, host))}\n`);
    expect(JSON.parse(io.out)).toMatchObject({
      root: project,
      configValid: true,
      ffmpeg: 'missing',
      browser: 'missing',
    });
  });

  it('exits 2 with the message and hint outside a project', async () => {
    const io = capture();
    const code = await checkCommand({ json: true }, io, { host, cwd: dir });
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toContain('demoflow.config.json');
    expect(io.err).toContain('hint:');
  });

  it('--project accepts a relative directory', async () => {
    const io = capture();
    await checkCommand({ project: 'project', json: true }, io, {
      host,
      cwd: dir,
      check: ready('system', 'installed'),
    });
    expect(JSON.parse(io.out).root).toBe(project);
  });

  it('--help lists the flags', async () => {
    const io = capture();
    expect(await main(['check', '--help'], io)).toBe(0);
    expect(io.out).toContain('--json');
  });
});
