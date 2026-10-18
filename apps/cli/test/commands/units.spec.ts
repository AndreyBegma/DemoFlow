import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError } from '../../src/commands/errors.ts';
import { exitCodeFor } from '../../src/commands/exit.ts';
import { formatJson, formatSummary } from '../../src/commands/output.ts';
import { assertSafeRunId, generateRunId } from '../../src/commands/run-id.ts';
import { settleRun } from '../../src/commands/settle.ts';

type StageStatus = RunResult['stages']['readiness']['status'];

function result(
  overrides: Partial<Record<keyof RunResult['stages'], StageStatus>> = {},
): RunResult {
  const status = (name: keyof RunResult['stages'], fallback: StageStatus) => ({
    status: overrides[name] ?? fallback,
  });
  const stages = {
    readiness: status('readiness', 'passed'),
    execution: status('execution', 'passed'),
    verification: status('verification', 'passed'),
    recording: status('recording', 'passed'),
    rendering: status('rendering', 'passed'),
    storage: status('storage', 'skipped'),
  };
  const failed = Object.values(stages).some((s) => s.status === 'failed');
  const open = Object.values(stages).some(
    (s) => s.status === 'pending' || s.status === 'running',
  );
  return {
    schemaVersion: 1,
    runId: '20261017-123456-abcdef',
    scenarioId: 'a.demo.json',
    scenarioName: 'A',
    startedAt: '2026-10-17T12:34:56.000Z',
    finishedAt: '2026-10-17T12:35:00.000Z',
    status: failed ? 'failed' : open ? 'running' : 'completed',
    stages,
    renders: [],
    warnings: [],
  };
}

describe('generateRunId', () => {
  it('is UTC date, UTC time and six lowercase base32 characters', () => {
    const id = generateRunId(new Date('2026-10-17T23:04:05.678Z'), () =>
      Uint8Array.from([0, 1, 25, 26, 31, 32]),
    );
    expect(id).toBe('20261017-230405-abz27a');
  });

  it('matches the documented shape for real randomness', () => {
    expect(generateRunId()).toMatch(/^\d{8}-\d{6}-[a-z2-7]{6}$/);
  });
});

describe('assertSafeRunId', () => {
  it.each([
    'task-1',
    '20261017-123456-abcdef',
    'a.b_c',
    '3f2b8c1e-0d4a-4e6f-9a7b-1c2d3e4f5a6b',
  ])('accepts %s', (id) => {
    expect(() => assertSafeRunId(id)).not.toThrow();
  });

  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/b',
    'a\\b',
    '/abs',
    'C:\\x',
    '.hidden',
    'a b',
    'a\0b',
    'a\nb',
  ])('rejects %j as an input error', (id) => {
    expect(() => assertSafeRunId(id)).toThrow(CommandError);
    try {
      assertSafeRunId(id);
    } catch (error) {
      expect((error as CommandError).exitCode).toBe(2);
      expect((error as CommandError).code).toBe('invalid-run-id');
    }
  });
});

describe('exitCodeFor', () => {
  it.each([
    [{}, 0],
    [{ readiness: 'failed', execution: 'skipped' }, 2],
    [{ execution: 'failed' }, 1],
    [{ verification: 'failed' }, 1],
    [{ recording: 'failed' }, 3],
    [{ rendering: 'failed' }, 3],
    [{ storage: 'failed' }, 3],
    [{ execution: 'failed', rendering: 'failed' }, 1],
  ] as const)('%j → %i', (stages, code) => {
    expect(exitCodeFor(result(stages))).toBe(code);
  });
});

describe('output', () => {
  it('--json is one line: the result plus runDir', () => {
    const text = formatJson(result(), '/runs/x');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({
      runDir: '/runs/x',
      status: 'completed',
    });
  });

  it('the summary lists every stage, the video and the run directory', () => {
    const run = result();
    run.renders = [
      {
        renderer: 'ffmpeg',
        file: 'render/ffmpeg.mp4',
        durationMs: 1,
        sizeBytes: 1,
        width: 1,
        height: 1,
        fps: 30,
      },
    ];
    const text = formatSummary(run, path.join('/runs', 'x'));
    expect(text).toContain('completed');
    expect(text).toContain('readiness');
    expect(text).toContain(
      `Video: ${path.join('/runs', 'x', 'render', 'ffmpeg.mp4')}`,
    );
  });
});

describe('settleRun', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function write(run: RunResult): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'demoflow-settle-'));
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(run));
    return dir;
  }

  it('skips storage and derives completed after a render', async () => {
    const run = await write(result({ storage: 'pending' }));
    const settled = await settleRun(run);
    expect(settled.stages.storage.status).toBe('skipped');
    expect(settled.status).toBe('completed');
    expect(
      JSON.parse(await readFile(path.join(run, 'result.json'), 'utf8')).status,
    ).toBe('completed');
  });

  it('skips rendering too when nothing was rendered, and keeps a failure', async () => {
    const run = await write(
      result({
        readiness: 'failed',
        execution: 'skipped',
        verification: 'skipped',
        recording: 'skipped',
        rendering: 'pending',
        storage: 'pending',
      }),
    );
    const settled = await settleRun(run);
    expect(settled.stages.rendering.status).toBe('skipped');
    expect(settled.stages.storage.status).toBe('skipped');
    expect(settled.status).toBe('failed');
  });
});
