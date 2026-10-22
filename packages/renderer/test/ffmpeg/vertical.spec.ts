import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunResultSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  ffmpegRenderer,
  probeVideo,
  renderPath,
  runFfmpeg,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

/** Spec 176 on a real run: the 9:16 MP4 beside the landscape one, or alone. */
describe.skipIf(!hasFfmpeg)('the vertical MP4 on a real run', () => {
  let parent: string;
  let recorded: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-vertical-'));
    recorded = await recordFixtureRun('customers', path.join(parent, 'source'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  /** A fresh copy of the recorded run, so each test starts with no render. */
  async function freshRun(name: string): Promise<string> {
    const runDir = path.join(parent, name);
    await cp(recorded, runDir, { recursive: true });
    return runDir;
  }

  it('writes the MP4 and the vertical MP4, both in renders[], the vertical 1080×1920 and playable', async () => {
    const runDir = await freshRun('both');
    const plan = await buildRenderPlan(runDir, {
      formats: ['mp4', 'mp4-vertical'],
    });
    const outputs = await ffmpegRenderer.render(runDir, plan);

    expect(outputs.map(({ format, file }) => ({ format, file }))).toEqual([
      { format: 'mp4', file: 'render/ffmpeg.mp4' },
      { format: 'mp4-vertical', file: 'render/ffmpeg.vertical.mp4' },
    ]);
    const result = RunResultSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')),
    );
    expect(result.renders).toEqual(outputs);
    expect(result.stages.rendering.status).toBe('passed');

    const mp4 = await probeVideo(renderPath(runDir, 'ffmpeg', 'mp4'));
    expect(mp4).toMatchObject({ width: 1920, height: 1080, codec: 'h264' });
    const file = renderPath(runDir, 'ffmpeg', 'mp4-vertical');
    const vertical = await probeVideo(file);
    expect(vertical).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
    });
    expect(Math.abs(vertical.durationMs - mp4.durationMs)).toBeLessThanOrEqual(
      100,
    );
    // It plays: every frame decodes, without an error.
    const { stderr } = await runFfmpeg([
      '-v',
      'error',
      '-i',
      file,
      '-f',
      'null',
      '-',
    ]);
    expect(stderr.trim()).toBe('');
  });

  it('writes only the vertical MP4 when only it is asked for', async () => {
    const runDir = await freshRun('vertical');
    const plan = await buildRenderPlan(runDir, { formats: ['mp4-vertical'] });
    const outputs = await ffmpegRenderer.render(runDir, plan);
    expect(outputs.map((output) => output.file)).toEqual([
      'render/ffmpeg.vertical.mp4',
    ]);
    expect(outputs[0]).toMatchObject({ width: 1080, height: 1920 });
    await expect(
      readFile(renderPath(runDir, 'ffmpeg', 'mp4')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
