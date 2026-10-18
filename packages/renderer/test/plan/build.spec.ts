import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunResultSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  frameAt,
  frameCount,
  parseProbe,
  probeVideo,
  type RenderPlan,
  recordRender,
  renderPath,
  runFfmpeg,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from './fixture-runs.ts';

/** The largest luma change between consecutive frames of a still picture. */
const CODEC_NOISE = 11;

/** Per frame, when it is shown and the largest luma change from the one before. */
async function frameChanges(
  file: string,
): Promise<{ atMs: number; change: number }[]> {
  const { stderr } = await runFfmpeg([
    '-i',
    file,
    '-map',
    '0:v:0',
    '-vf',
    'tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX',
    '-f',
    'null',
    '-',
  ]);
  return [
    ...stderr.matchAll(
      /pts_time:([\d.]+)\s*\n[^\n]*lavfi\.signalstats\.YMAX=(\d+)/g,
    ),
  ].map((match) => ({
    atMs: Number(match[1]) * 1000,
    change: Number(match[2]),
  }));
}

if (!hasFfmpeg) {
  console.warn('no usable FFmpeg: skipping the render plan integration tests');
}

describe('parseProbe', () => {
  it('reads a Playwright WebM and its frozen stretches, one running to the end', () => {
    // Max luma change per frame (25 fps): moving, still, moving, still to the end.
    const diffs = [200, 3, 3, 3, 3, 3, 90, 3, 3, 3, 3];
    const log = [
      '  Duration: 00:00:00.48, start: 0.000000, bitrate: 206 kb/s',
      '  Stream #0:0(eng): Video: vp9 (Profile 0), yuv420p(tv, progressive), 1280x720, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 1k tbn (default)',
      ...diffs.flatMap((diff, index) => [
        `[Parsed_metadata_2 @ 0x1] frame:${index} pts:${(index + 1) * 40} pts_time:${(index + 1) * 0.04}`,
        `[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YMAX=${diff}`,
      ]),
    ].join('\n');
    const probe = parseProbe('frame=12\nprogress=end\n', log, { minMs: 150 });
    expect(probe).toMatchObject({
      width: 1280,
      height: 720,
      fps: 25,
      durationMs: 480,
      codec: 'vp9',
      pixelFormat: 'yuv420p',
    });
    // Frames 1–6 are one picture (40–240 ms); frames 7–11 another, to the end.
    expect(probe.freezes).toHaveLength(2);
    expect(probe.freezes[0].startMs).toBeCloseTo(40);
    expect(probe.freezes[0].endMs).toBeCloseTo(280);
    expect(probe.freezes[1].startMs).toBeCloseTo(280);
    expect(probe.freezes[1].endMs).toBeCloseTo(480);
    // Shorter than `minMs`: not reported.
    expect(
      parseProbe('', log, { minMs: 220 }).freezes.map((f) => f.startMs),
    ).toEqual([expect.closeTo(40)]);
    // Without freeze options the probe reports none.
    expect(parseProbe('', log).freezes).toEqual([]);
  });

  it('reads an MP4 and falls back to the frame count without a duration', () => {
    const probe = parseProbe(
      'frame=10\nframe=90\nprogress=end\n',
      '  Duration: N/A\n  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 139 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
    );
    expect(probe).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 3000,
    });
  });
});

describe.skipIf(!hasFfmpeg)('buildRenderPlan on real runs', () => {
  let parent: string;
  let customers: string;
  let failing: string;
  let tour: string;
  let customersPlan: RenderPlan;
  let failingPlan: RenderPlan;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-plan-'));
    customers = await recordFixtureRun('customers', parent);
    failing = await recordFixtureRun('failing', parent);
    tour = await recordFixtureRun('tour', parent);
    customersPlan = await buildRenderPlan(customers);
    failingPlan = await buildRenderPlan(failing);
    // Three real recordings at device pixels: over 120 s on a macOS runner.
  }, 300_000);

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('records the source at device pixels (2×), so the zoom is 1.6', () => {
    // `videoSize` is viewport × deviceScaleFactor (#17, ADR-0004 §1).
    expect(customersPlan.source).toMatchObject({
      file: 'source.webm',
      width: 2560,
      height: 1440,
      fps: 25,
      scale: 2,
    });
    const zooms = customersPlan.camera.map((key) => key.zoom);
    expect(Math.max(...zooms)).toBeCloseTo(1.6);
  });

  it('plans the customers run: cursor, rings, captions, no failure', () => {
    expect(customersPlan.clicks).toHaveLength(2);
    expect(customersPlan.cursor).toHaveLength(2);
    expect(customersPlan.captions.map((caption) => caption.text)).toEqual([
      'Search the list',
      'Open the dialog',
      'Create the customer',
    ]);
    expect(customersPlan.failure).toBeUndefined();
    expect(customersPlan.masks).toEqual([]);
  });

  it('compresses the failing run’s frozen assertion wait and ends on the card', async () => {
    // The assertion waits out its timeout on a frozen page, and the plan cuts
    // that wait down. The wait is read from the run's own timeline: a slow
    // runner's video can be shorter than the wait (9 960 ms of a 10 s wait on
    // macOS CI), so the check is on what the plan saved, not on a fixed length.
    const events = JSON.parse(
      await readFile(path.join(failing, 'timeline.json'), 'utf8'),
    ).events as { startMs: number; endMs: number }[];
    const wait = events.at(-1);
    if (wait === undefined) throw new Error('failing run has no events');
    const waitMs = wait.endMs - wait.startMs;
    const videoEndMs = failingPlan.timeMap.at(-1)?.outputEndMs ?? 0;
    expect(videoEndMs).toBeLessThan(2_000);
    expect(failingPlan.source.durationMs - videoEndMs).toBeGreaterThan(
      waitMs * 0.8,
    );
    expect(failingPlan.failure?.endCard.text).toMatch(
      /^Verification failed at step 3: /,
    );
    const last = frameAt(failingPlan, frameCount(failingPlan) - 1);
    expect(last.watermark).toBe(true);
    expect(last.endCard).toBe(failingPlan.failure?.endCard.text);
    expect(frameAt(failingPlan, 0).watermark).toBe(true);
  });

  it('keeps the slow report’s spinner: the wait for it plays in real time', async () => {
    const plan = await buildRenderPlan(tour);
    const timeline = JSON.parse(
      await readFile(path.join(tour, 'timeline.json'), 'utf8'),
    ) as { events: { action: string; startMs: number; endMs: number }[] };
    // `waitFor "Report ready"` spans the ~1.8 s the 12 px spinner turns.
    const wait = timeline.events.findLast(
      (event) => event.action === 'waitFor',
    );
    if (wait === undefined) throw new Error('tour has no waitFor');
    const from = wait.startMs + plan.offsetMs + 100;
    const to = wait.endMs + plan.offsetMs - 200;
    // On failure, show whether the source itself froze there (frames the
    // runner never delivered) or the plan compressed motion.
    const { freezes } = await probeVideo(path.join(tour, plan.source.file), {
      freezes: { minMs: 1_000 },
    });
    // The renderer may only compress what the source does not change. Motion
    // is measured here, apart from the renderer's idle rule: per frame, the
    // largest luma change from the previous one, with codec noise (peaks at 11
    // luma levels) as the floor. A slow runner can deliver no frames at all
    // for a stretch of the wait (a stalled screencast); compressing that is
    // correct, so it is reported, not failed.
    const motion = await frameChanges(path.join(tour, plan.source.file));
    expect(motion.length, 'no frame changes read from FFmpeg').toBeGreaterThan(
      10,
    );
    for (const segment of plan.timeMap) {
      if (segment.sourceEndMs <= from || segment.sourceStartMs >= to) continue;
      const compressed =
        segment.outputEndMs - segment.outputStartMs <
        segment.sourceEndMs - segment.sourceStartMs - 1;
      if (!compressed) continue;
      const moved = motion.filter(
        (frame) =>
          frame.atMs > segment.sourceStartMs &&
          frame.atMs <= segment.sourceEndMs &&
          frame.change > CODEC_NOISE,
      );
      expect(
        moved,
        `segment ${JSON.stringify(segment)} inside the spinner was compressed although the source moves; source freezes ${JSON.stringify(freezes)}`,
      ).toEqual([]);
      console.warn(
        `the source stalls inside the spinner wait (no change over ${JSON.stringify(segment)}; renderer freezes ${JSON.stringify(freezes)}): the screencast delivered no new frames`,
      );
    }
  });

  it('records a render in result.json, and a failed one as a failed stage', async () => {
    const file = renderPath(customers, 'probe');
    const output = await recordRender(customers, 'probe', file, async () => {
      await runFfmpeg([
        '-y',
        '-i',
        path.join(customers, customersPlan.source.file),
        '-t',
        '1',
        '-vf',
        'scale=1920:1080,fps=30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        file,
      ]);
    });
    expect(output).toMatchObject({
      renderer: 'probe',
      file: 'render/probe.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
    });
    expect(output.sizeBytes).toBeGreaterThan(0);
    const mp4 = await probeVideo(file);
    expect(mp4).toMatchObject({ codec: 'h264', pixelFormat: 'yuv420p' });

    const read = async () =>
      RunResultSchema.parse(
        JSON.parse(await readFile(path.join(customers, 'result.json'), 'utf8')),
      );
    let result = await read();
    expect(result.renders).toEqual([output]);
    expect(result.stages.rendering.status).toBe('passed');
    // Storage is the CLI's (#5); until then the run is still running.
    expect(result.status).toBe('running');

    await expect(
      recordRender(customers, 'broken', renderPath(customers, 'broken'), () =>
        Promise.reject(new Error('compositor crashed')),
      ),
    ).rejects.toThrow('compositor crashed');
    result = await read();
    expect(result.stages.rendering).toMatchObject({
      status: 'failed',
      error: { message: 'compositor crashed' },
    });
    expect(result.status).toBe('failed');
    expect(result.renders.map((entry) => entry.renderer)).toEqual(['probe']);

    // A failed render does not make the next plan of the run a failed video.
    expect((await buildRenderPlan(customers)).failure).toBeUndefined();
  });

  it('serialises concurrent updates of one result.json', async () => {
    const file = path.join(failing, 'result.json');
    const original = await readFile(file, 'utf8');
    const draw = (name: string) => async () => {
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x180:d=0.2:r=30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        renderPath(failing, name),
      ]);
    };
    await Promise.all([
      recordRender(failing, 'a', renderPath(failing, 'a'), draw('a')),
      recordRender(failing, 'b', renderPath(failing, 'b'), draw('b')),
    ]);
    const result = RunResultSchema.parse(
      JSON.parse(await readFile(file, 'utf8')),
    );
    expect(result.renders.map((entry) => entry.renderer).sort()).toEqual([
      'a',
      'b',
    ]);
    // The verification failure still decides the run.
    expect(result.status).toBe('failed');
    await writeFile(file, original);
  });
});
