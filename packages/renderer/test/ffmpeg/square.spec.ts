import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunResultSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompositor, LOOK } from '../../src/ffmpeg/compose.ts';
import { lineHeight, wrapText } from '../../src/ffmpeg/font.ts';
import { createPicture } from '../../src/ffmpeg/raster.ts';
import {
  buildRenderPlan,
  type FrameState,
  ffmpegRenderer,
  type OutputSpec,
  probeVideo,
  renderPath,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

/** Spec 304: the square lane, drawn and encoded. */

const SQUARE_OUTPUT: OutputSpec = {
  width: 1080,
  height: 1080,
  fps: 30,
  files: [
    {
      format: 'mp4-square',
      codec: 'h264',
      pixelFormat: 'yuv420p',
      faststart: true,
    },
  ],
};

describe('the square caption band', () => {
  const band = { top: 1080 - 238, height: 238, fontPx: 48, maxLines: 2 };
  const caption =
    'Every invoice that was sent to a customer last month is listed here, with its status, its total and the person who sent it';

  function draw(text: string) {
    const target = createPicture(1080, 1080);
    const state: FrameState = {
      sourceMs: null,
      crop: { x: 0, y: 0, width: 1080, height: 1080 },
      content: { x: 0, y: 0, width: 1080, height: 1080 },
      scale: 1,
      rings: [],
      masks: [],
      watermark: false,
      caption: text,
    };
    createCompositor(SQUARE_OUTPUT, undefined, band).compose(target, state);
    return target;
  }

  /** The first and last rows with white pixels: the text, on the black behind it. */
  function inkRows(picture: ReturnType<typeof draw>) {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < picture.height; y++) {
      for (let x = 0; x < picture.width; x++) {
        const at = (y * picture.width + x) * 3;
        const { data } = picture;
        if (data[at] > 200 && data[at + 1] > 200 && data[at + 2] > 200) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          break;
        }
      }
    }
    return { top, bottom };
  }

  it('cuts a three-line caption to two lines, inside the band', () => {
    const style = { ...LOOK.caption.text, fontPx: band.fontPx };
    const width = 1080 - 2 * LOOK.vertical.marginX - 2 * LOOK.caption.padding;
    expect(wrapText(caption, style, width).length).toBeGreaterThanOrEqual(3);

    const { top, bottom } = inkRows(draw(caption));
    expect(top).toBeGreaterThanOrEqual(band.top);
    expect(bottom).toBeLessThan(band.top + band.height);
    // Two lines of ink are shorter than two line heights; three are longer.
    expect(bottom - top + 1).toBeLessThan(2 * lineHeight(style));
    expect(bottom - top + 1).toBeGreaterThan(lineHeight(style));
  });
});

describe.skipIf(!hasFfmpeg)('square formats on a real run', () => {
  let parent: string;
  let recorded: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-square-'));
    recorded = await recordFixtureRun('customers', path.join(parent, 'source'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function freshRun(name: string): Promise<string> {
    const runDir = path.join(parent, name);
    await cp(recorded, runDir, { recursive: true });
    return runDir;
  }

  it('writes the four files in one render, and lists them', async () => {
    const runDir = await freshRun('all');
    const plan = await buildRenderPlan(runDir, {
      formats: ['mp4', 'mp4-square', 'gif-square', 'webm-square'],
    });
    const outputs = await ffmpegRenderer.render(runDir, plan);
    expect(outputs.map((output) => output.format)).toEqual([
      'mp4',
      'mp4-square',
      'gif-square',
      'webm-square',
    ]);
    expect(outputs.map((output) => output.file)).toEqual([
      'render/ffmpeg.mp4',
      'render/ffmpeg.square.mp4',
      'render/ffmpeg.square.gif',
      'render/ffmpeg.square.webm',
    ]);
    const result = RunResultSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')),
    );
    expect(result.renders).toEqual(outputs);

    const mp4 = await probeVideo(renderPath(runDir, 'ffmpeg', 'mp4-square'));
    expect(mp4).toMatchObject({
      width: 1080,
      height: 1080,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
    });
    expect(Math.abs(mp4.durationMs - plan.durationMs)).toBeLessThanOrEqual(100);

    const webm = await probeVideo(renderPath(runDir, 'ffmpeg', 'webm-square'));
    expect(webm).toMatchObject({
      width: 1080,
      height: 1080,
      codec: 'vp9',
    });
    expect(Math.abs(webm.durationMs - mp4.durationMs)).toBeLessThanOrEqual(100);

    const gif = await probeVideo(renderPath(runDir, 'ffmpeg', 'gif-square'));
    expect(gif).toMatchObject({
      width: 600,
      height: 600,
      fps: 12,
      codec: 'gif',
    });
    expect(Math.abs(gif.durationMs - mp4.durationMs)).toBeLessThanOrEqual(100);
  });

  it('writes only the square MP4 when only that is asked for', async () => {
    const runDir = await freshRun('only');
    const plan = await buildRenderPlan(runDir, { formats: ['mp4-square'] });
    const outputs = await ffmpegRenderer.render(runDir, plan);
    expect(outputs.map((output) => output.file)).toEqual([
      'render/ffmpeg.square.mp4',
    ]);
    for (const format of ['mp4', 'mp4-vertical'] as const) {
      await expect(
        readFile(renderPath(runDir, 'ffmpeg', format)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('writes the vertical and the square MP4 from one render', async () => {
    const runDir = await freshRun('both');
    const plan = await buildRenderPlan(runDir, {
      formats: ['mp4-vertical', 'mp4-square'],
    });
    await ffmpegRenderer.render(runDir, plan);
    const vertical = await probeVideo(
      renderPath(runDir, 'ffmpeg', 'mp4-vertical'),
    );
    const square = await probeVideo(renderPath(runDir, 'ffmpeg', 'mp4-square'));
    expect(vertical).toMatchObject({ width: 1080, height: 1920 });
    expect(square).toMatchObject({ width: 1080, height: 1080 });
  });
});
