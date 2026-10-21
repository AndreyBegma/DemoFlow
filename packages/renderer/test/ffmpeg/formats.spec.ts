import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunResultSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encoderArgs } from '../../src/ffmpeg/pipeline.ts';
import {
  buildRenderPlan,
  chooseFfmpeg,
  ffmpegRenderer,
  type OutputSpec,
  probeVideo,
  renderPath,
  runFfmpeg,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

/** Every FFmpeg the renderer starts, and the encoders a test pretends it lacks. */
const spied = vi.hoisted(() => ({
  spawns: [] as string[][],
  lacking: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((
    command: string,
    args: readonly string[],
    options: object,
  ) => {
    spied.spawns.push([...args]);
    return actual.spawn(command, args, options);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

vi.mock('../../src/plan/ffmpeg.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/plan/ffmpeg.ts')>();
  return {
    ...actual,
    missingEncoders: (binary: string, required: readonly string[]) => [
      ...actual.missingEncoders(binary, required),
      ...required.filter((name) => spied.lacking.includes(name)),
    ],
  };
});

const MP4 = {
  format: 'mp4',
  codec: 'h264',
  pixelFormat: 'yuv420p',
  faststart: true,
} as const;

const OUTPUT: OutputSpec = { width: 1920, height: 1080, fps: 30, files: [MP4] };

describe('encoderArgs', () => {
  it('writes the MP4 alone with the encoder settings it had before spec 133', () => {
    expect(encoderArgs(OUTPUT, ['out.mp4'])).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      '1920x1080',
      '-r',
      '30',
      '-i',
      'pipe:0',
      '-filter_complex',
      '[0:v]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[v0]',
      '-map',
      '[v0]',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      'out.mp4',
    ]);
  });

  it('splits one input into every file, in order', () => {
    const args = encoderArgs(
      {
        ...OUTPUT,
        files: [
          { format: 'gif', width: 800, height: 450, fps: 12 },
          MP4,
          {
            format: 'webm',
            codec: 'vp9',
            pixelFormat: 'yuv420p',
            crf: 32,
            cpuUsed: 4,
          },
        ],
      },
      ['a.gif', 'b.mp4', 'c.webm'],
    );
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toMatch(/^\[0:v\]split=3\[s0\]\[s1\]\[s2\];/);
    expect(graph).toContain(
      '[s0]fps=12,scale=800:450:flags=lanczos,split[g0][h0];[g0]palettegen',
    );
    // A palette per frame: one for the whole video queues every frame (spec 133).
    expect(graph).toContain('[g0]palettegen=stats_mode=single[p0]');
    expect(graph).toContain('[h0][p0]paletteuse=new=1:');
    // Each file follows its own `-map`, with its own encoder.
    const maps = args.flatMap((arg, i) => (arg === '-map' ? [i] : []));
    expect(maps.map((i) => args[i + 1])).toEqual(['[v0]', '[v1]', '[v2]']);
    const encoders = args.flatMap((arg, i) =>
      arg === '-c:v' ? [args[i + 1]] : [],
    );
    expect(encoders).toEqual(['gif', 'libx264', 'libvpx-vp9']);
    expect(args.slice(args.indexOf('libvpx-vp9'))).toEqual(
      expect.arrayContaining(['-b:v', '0', '-row-mt', '1']),
    );
    expect(args.indexOf('a.gif')).toBeLessThan(args.indexOf('b.mp4'));
    expect(args.at(-1)).toBe('c.webm');
  });

  it('refuses a path count that does not match the files', () => {
    expect(() => encoderArgs(OUTPUT, [])).toThrow('one path per output');
  });
});

describe('chooseFfmpeg', () => {
  const listing = (...names: string[]) =>
    [
      'Encoders:',
      ' V..... = Video',
      ' ------',
      ...names.map((name) => ` V....D ${name}  ${name} encoder`),
    ].join('\n');
  const bundled = () => '/bundled/ffmpeg';

  it('takes the system FFmpeg when it has every encoder required', () => {
    expect(
      chooseFfmpeg(
        listing('libx264', 'libvpx-vp9', 'gif'),
        ['libx264', 'libvpx-vp9'],
        bundled,
      ),
    ).toBe('ffmpeg');
  });

  it('skips a system FFmpeg without libvpx-vp9 when WebM is wanted', () => {
    const system = listing('libx264', 'libvpx', 'gif');
    expect(chooseFfmpeg(system, ['libx264'], bundled)).toBe('ffmpeg');
    expect(chooseFfmpeg(system, ['libx264', 'libvpx-vp9'], bundled)).toBe(
      '/bundled/ffmpeg',
    );
  });

  it('skips a system FFmpeg without libx264, or none at all', () => {
    expect(chooseFfmpeg(listing('libvpx-vp9'), ['libx264'], bundled)).toBe(
      '/bundled/ffmpeg',
    );
    expect(chooseFfmpeg(null, ['libx264'], bundled)).toBe('/bundled/ffmpeg');
  });
});

describe.skipIf(!hasFfmpeg)('render formats on a real run', () => {
  let parent: string;
  let recorded: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-formats-'));
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

  async function readResult(runDir: string) {
    return RunResultSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')),
    );
  }

  /** The encoders started since `from`: the only FFmpeg reading frames on stdin. */
  function encoders(from: number): string[][] {
    return spied.spawns.slice(from).filter((args) => args.includes('pipe:0'));
  }

  it('writes MP4, GIF and WebM from one encoder, and lists them in order', async () => {
    const runDir = await freshRun('all');
    const plan = await buildRenderPlan(runDir, {
      formats: ['mp4', 'gif', 'webm'],
    });
    const from = spied.spawns.length;
    const started = performance.now();
    const outputs = await ffmpegRenderer.render(runDir, plan);
    const elapsedMs = performance.now() - started;
    expect(encoders(from)).toHaveLength(1);

    expect(outputs.map((output) => output.format)).toEqual([
      'mp4',
      'gif',
      'webm',
    ]);
    expect(outputs.map((output) => output.file)).toEqual([
      'render/ffmpeg.mp4',
      'render/ffmpeg.gif',
      'render/ffmpeg.webm',
    ]);
    const result = await readResult(runDir);
    expect(result.renders).toEqual(outputs);
    expect(result.stages.rendering.status).toBe('passed');

    const mp4 = await probeVideo(renderPath(runDir, 'ffmpeg', 'mp4'));
    expect(mp4).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
    });
    expect(Math.abs(mp4.durationMs - plan.durationMs)).toBeLessThanOrEqual(100);

    const webmFile = renderPath(runDir, 'ffmpeg', 'webm');
    const webm = await probeVideo(webmFile);
    expect(webm).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'vp9',
      pixelFormat: 'yuv420p',
    });
    expect(Math.abs(webm.durationMs - mp4.durationMs)).toBeLessThanOrEqual(100);
    const { stderr } = await runFfmpeg([
      '-i',
      webmFile,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    expect(stderr).toMatch(/Video: vp9 [^\n]*yuv420p\(tv, bt709[,)]/);

    const gif = await probeVideo(renderPath(runDir, 'ffmpeg', 'gif'));
    expect(gif).toMatchObject({
      width: 800,
      height: 450,
      fps: 12,
      codec: 'gif',
    });
    expect(Math.abs(gif.durationMs - mp4.durationMs)).toBeLessThanOrEqual(150);
    const [, gifEntry] = outputs;
    expect(gifEntry).toMatchObject({ width: 800, height: 450, fps: 12 });
    // The PR states these numbers (spec 133, acceptance criteria).
    console.info(
      `formats: ${(plan.durationMs / 1000).toFixed(1)} s demo encoded in ${(elapsedMs / 1000).toFixed(1)} s; ` +
        outputs
          .map(
            (output) =>
              `${output.format} ${(output.sizeBytes / 1e6).toFixed(2)} MB`,
          )
          .join(', '),
    );
    expect(gifEntry.sizeBytes).toBeLessThan(10_000_000);
  });

  it('writes only the GIF when only the GIF is asked for', async () => {
    const runDir = await freshRun('gif');
    const plan = await buildRenderPlan(runDir, { formats: ['gif'] });
    const outputs = await ffmpegRenderer.render(runDir, plan);
    expect(outputs.map((output) => output.file)).toEqual(['render/ffmpeg.gif']);
    await expect(
      readFile(renderPath(runDir, 'ffmpeg', 'mp4')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the rendering stage, naming the format, when its encoder is missing', async () => {
    const runDir = await freshRun('missing');
    const plan = await buildRenderPlan(runDir, { formats: ['mp4', 'webm'] });
    spied.lacking = ['libvpx-vp9'];
    const from = spied.spawns.length;
    try {
      await expect(ffmpegRenderer.render(runDir, plan)).rejects.toThrow(
        /cannot encode the webm: .* has no libvpx-vp9 encoder/,
      );
    } finally {
      spied.lacking = [];
    }
    expect(encoders(from)).toEqual([]);
    const result = await readResult(runDir);
    expect(result.stages.rendering).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('webm') },
    });
    expect(result.status).toBe('failed');
    expect(result.renders).toEqual([]);
  });
});
