import { describe, expect, it } from 'vitest';
import {
  deriveRunStatus,
  RunResultSchema,
  type RunStatus,
  STAGE_NAMES,
  type StageName,
  type StageStatus,
} from '../src/index.ts';

function stages(overrides: Partial<Record<StageName, StageStatus>> = {}) {
  return Object.fromEntries(
    STAGE_NAMES.map((name) => [name, { status: overrides[name] ?? 'passed' }]),
  ) as Record<StageName, { status: StageStatus }>;
}

describe('deriveRunStatus', () => {
  it.each<{
    rule: string;
    overrides: Partial<Record<StageName, StageStatus>>;
    warnings: string[];
    expected: RunStatus;
  }>([
    { rule: 'all passed', overrides: {}, warnings: [], expected: 'completed' },
    {
      rule: 'passed and skipped',
      overrides: { storage: 'skipped', rendering: 'skipped' },
      warnings: [],
      expected: 'completed',
    },
    {
      rule: 'all skipped',
      overrides: Object.fromEntries(STAGE_NAMES.map((n) => [n, 'skipped'])),
      warnings: [],
      expected: 'completed',
    },
    {
      rule: 'all passed, with warnings',
      overrides: {},
      warnings: ['css-locator'],
      expected: 'completed_with_warnings',
    },
    {
      rule: 'one stage failed',
      overrides: { storage: 'failed' },
      warnings: [],
      expected: 'failed',
    },
    {
      rule: 'verification failed, rendering passed',
      overrides: { verification: 'failed', rendering: 'passed' },
      warnings: [],
      expected: 'failed',
    },
    {
      rule: 'failed wins over running',
      overrides: { execution: 'failed', rendering: 'running' },
      warnings: [],
      expected: 'failed',
    },
    {
      rule: 'failed wins over warnings',
      overrides: { readiness: 'failed' },
      warnings: ['css-locator'],
      expected: 'failed',
    },
    {
      rule: 'one stage running',
      overrides: { recording: 'running' },
      warnings: [],
      expected: 'running',
    },
    {
      rule: 'one stage pending',
      overrides: { storage: 'pending' },
      warnings: ['css-locator'],
      expected: 'running',
    },
  ])('$rule → $expected', ({ overrides, warnings, expected }) => {
    expect(deriveRunStatus(stages(overrides), warnings)).toBe(expected);
  });

  it('treats a missing warnings argument as none', () => {
    expect(deriveRunStatus(stages())).toBe('completed');
  });
});

describe('RunResultSchema', () => {
  const result = {
    schemaVersion: 1,
    runId: 'run_01',
    scenarioId: 'demoflow/onboarding.demo.json',
    scenarioName: 'Onboarding',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:01:30.000+02:00',
    status: 'completed',
    stages: stages(),
    renders: [
      {
        renderer: 'remotion',
        file: 'render.mp4',
        durationMs: 42_000,
        sizeBytes: 3_100_000,
        width: 1920,
        height: 1080,
        fps: 30,
      },
    ],
    warnings: [],
  };

  it('parses a run result', () => {
    expect(RunResultSchema.safeParse(result).success).toBe(true);
  });

  it('rejects a status that the stages do not support', () => {
    const parsed = RunResultSchema.safeParse({
      ...result,
      stages: {
        ...stages({ verification: 'failed' }),
        verification: {
          status: 'failed',
          error: { message: 'text not found', stepIndex: 4 },
        },
      },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['status']);
  });

  it('rejects a timestamp that is not ISO 8601', () => {
    expect(
      RunResultSchema.safeParse({ ...result, startedAt: '17/10/2026' }).success,
    ).toBe(false);
  });

  it('reads a render written before spec 133, without a format, as MP4', () => {
    const parsed = RunResultSchema.parse(result);
    expect(parsed.renders[0]?.format).toBe('mp4');
  });

  it('keeps each render format, in order, and rejects an unknown one', () => {
    const [render] = result.renders;
    const renders = (['gif', 'webm', 'mp4', 'mp4-vertical'] as const).map(
      (format) => ({
        ...render,
        format,
        file: `render/ffmpeg.${format}`,
      }),
    );
    expect(
      RunResultSchema.parse({ ...result, renders }).renders.map(
        (entry) => entry.format,
      ),
    ).toEqual(['gif', 'webm', 'mp4', 'mp4-vertical']);
    expect(
      RunResultSchema.safeParse({
        ...result,
        renders: [{ ...render, format: 'avi' }],
      }).success,
    ).toBe(false);
  });
});
