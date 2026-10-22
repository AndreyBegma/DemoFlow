import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RunResultSchema } from '@demoflow/core';
import type { EngineObserver } from '@demoflow/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  DEFAULT_OFFSET_MS,
  frameAt,
  frameCount,
  parseProbe,
  probeVideo,
  type RenderPlan,
  type Rgb,
  recordRender,
  renderPath,
  runFfmpeg,
  runFfmpegRaw,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from './fixture-runs.ts';

/** The largest luma change between consecutive frames of a still picture. */
const CODEC_NOISE = 11;

/** Frames above the noise floor that make a stretch moving, not a blip. */
const MOTION_FRAMES = 3;

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

/** Playwright records at a fixed 25 fps; the drift method decodes at it. */
const DRIFT_FRAME_MS = 40;

/** Round trips the drift probe makes to map the page clock; it keeps the shortest. */
const PROBE_EXCHANGES = 7;

/** The page's absolute high-resolution time: it holds across a document change. */
const PAGE_NOW = 'performance.timeOrigin + performance.now()';

/**
 * The page side of the clock-drift method, on the sync mark: the page timestamps
 * the removal of the mark on its own clock, and the probe maps that instant to a
 * clock started where the engine's is. The binding's arrival time is never used:
 * on a loaded runner it lands tens of milliseconds late (#62). The mapping is
 * written here, not taken from the engine, so the two cannot share a bug.
 */
function clearProbe(): {
  observer: EngineObserver;
  clearedAtMs: () => number;
  roundTripMs: () => number;
} {
  let zero = Number.NaN;
  let clearedOnPageMs = Number.NaN;
  let pageToNodeMs = Number.NaN;
  let roundTripMs = Number.POSITIVE_INFINITY;
  return {
    observer: {
      async onPageCreated({ page }) {
        zero = performance.now();
        await page.exposeFunction('__demoflowCleared', (pageMs: number) => {
          if (Number.isNaN(clearedOnPageMs)) clearedOnPageMs = pageMs;
        });
        // The mark is the only child removed from the blank page.
        await page.evaluate(`new MutationObserver((records) => {
          if (records.some((record) => record.removedNodes.length > 0)) {
            window.__demoflowCleared(${PAGE_NOW});
          }
        }).observe(document.documentElement, { childList: true })`);
        // NTP-style: the page read its clock somewhere inside [t0, t1]; the
        // shortest round trip bounds that error tightest.
        for (let i = 0; i < PROBE_EXCHANGES; i++) {
          const t0 = performance.now();
          const pageMs = await page.evaluate<number>(PAGE_NOW);
          const t1 = performance.now();
          if (t1 - t0 < roundTripMs) {
            roundTripMs = t1 - t0;
            pageToNodeMs = (t0 + t1) / 2 - pageMs;
          }
        }
      },
    },
    clearedAtMs: () => clearedOnPageMs + pageToNodeMs - zero,
    roundTripMs: () => roundTripMs,
  };
}

/** clock-drift.spec.ts's decode: 4×4 RGB frames at 25 fps; the top-left pixel of each. */
async function driftFrames(file: string): Promise<Rgb[]> {
  const { stdout } = await runFfmpegRaw([
    '-v',
    'error',
    '-t',
    '3',
    '-i',
    file,
    '-vf',
    'fps=25,scale=4:4',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  const size = 4 * 4 * 3;
  const out: Rgb[] = [];
  for (let at = 0; at + size <= stdout.length; at += size) {
    out.push([stdout[at], stdout[at + 1], stdout[at + 2]]);
  }
  return out;
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

  it('reads a GIF at its tbr, not the rate of one rounded delay', () => {
    const probe = parseProbe(
      'progress=end\n',
      '  Duration: 00:00:05.00, start: 0.000000, bitrate: 581 kb/s\n  Stream #0:0: Video: gif, bgra, 800x450 [SAR 1:1 DAR 16:9], 12.50 fps, 12 tbr, 100 tbn',
    );
    expect(probe).toMatchObject({
      codec: 'gif',
      width: 800,
      height: 450,
      fps: 12,
      durationMs: 5000,
    });
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
  let customersClearedAtMs: number;
  let customersRoundTripMs: number;
  let failingPlan: RenderPlan;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-plan-'));
    const probe = clearProbe();
    customers = await recordFixtureRun('customers', parent, [probe.observer]);
    customersClearedAtMs = probe.clearedAtMs();
    customersRoundTripMs = probe.roundTripMs();
    failing = await recordFixtureRun('failing', parent);
    tour = await recordFixtureRun('tour', parent);
    customersPlan = await buildRenderPlan(customers);
    failingPlan = await buildRenderPlan(failing);
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('records the source at the viewport size (1×), so zoom: true is 1.25', () => {
    // `videoSize` is the viewport: Playwright pads a larger canvas instead of
    // upscaling (#47).
    expect(customersPlan.source).toMatchObject({
      file: 'source.webm',
      width: 1280,
      height: 720,
      fps: 25,
      scale: 1,
    });
    const zooms = customersPlan.camera.map((key) => key.zoom);
    expect(Math.max(...zooms)).toBeCloseTo(1.25);
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

  // Runs on CI. The stalls once seen there (#40) came from the 2× capture;
  // at 1× the longest gap between moving source frames in the spinner window
  // over 5 runs per OS was 180 ms (Linux), 218 ms (macOS), 266 ms (Windows).
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
      // A turning spinner changes nearly every frame; one lone frame above the
      // floor in a stall is a codec refresh (a 21 amid 1.7 s of stall on
      // Ubuntu CI), not motion.
      expect(
        moved.length,
        `segment ${JSON.stringify(segment)} inside the spinner was compressed although the source moves (${JSON.stringify(moved)}); source freezes ${JSON.stringify(freezes)}`,
      ).toBeLessThan(MOTION_FRAMES);
      console.warn(
        `the source stalls inside the spinner wait (no change over ${JSON.stringify(segment)}; renderer freezes ${JSON.stringify(freezes)}): the screencast delivered no new frames`,
      );
    }
  });

  it('records a render in result.json, and a failed one as a failed stage', async () => {
    const file = renderPath(customers, 'probe');
    const [output] = await recordRender(
      customers,
      'probe',
      [{ format: 'mp4', file }],
      async () => {
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
      },
    );
    expect(output).toMatchObject({
      renderer: 'probe',
      format: 'mp4',
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
      recordRender(
        customers,
        'broken',
        [{ format: 'mp4', file: renderPath(customers, 'broken') }],
        () => Promise.reject(new Error('compositor crashed')),
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
      recordRender(
        failing,
        'a',
        [{ format: 'mp4', file: renderPath(failing, 'a') }],
        draw('a'),
      ),
      recordRender(
        failing,
        'b',
        [{ format: 'mp4', file: renderPath(failing, 'b') }],
        draw('b'),
      ),
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

  it('measures the offset within 20 ms of the clock-drift method (#19, #48)', async () => {
    const plan = customersPlan;
    // #48: the mark is in every recording, not in most.
    expect(plan.offsetMeasured, 'the sync mark was not found').toBe(true);
    expect(plan.maskLeadMs).toBe(120);
    expect(plan.maskTrailMs).toBe(120);

    // clock-drift.spec.ts: the first frame showing the change, less the
    // instant the page reported it, both decoded and timed independently.
    const decoded = await driftFrames(path.join(customers, plan.source.file));
    const isMark = (pixel: Rgb): boolean =>
      pixel[0] > 200 && pixel[1] < 100 && pixel[2] > 200;
    const markAt = decoded.findIndex(isMark);
    const clearAt = decoded.findIndex(
      (pixel, i) => i > markAt && !isMark(pixel),
    );
    expect(markAt, 'no mark frame in the video').toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(markAt);
    expect(
      customersClearedAtMs,
      'the page never reported the clear',
    ).toBeGreaterThan(0);
    const driftOffsetMs = clearAt * DRIFT_FRAME_MS - customersClearedAtMs;
    console.info(
      `sync offset: renderer ${plan.offsetMs.toFixed(1)} ms, drift method ${driftOffsetMs.toFixed(1)} ms (probe round trip ${customersRoundTripMs.toFixed(1)} ms)`,
    );
    // Both read the same clear frame, so they differ only by when the clear
    // was timed. Both time it on the page clock now (#48, #62); the probe's
    // DOM removal comes no later than the engine's first frame without the mark.
    expect(Math.abs(plan.offsetMs - driftOffsetMs)).toBeLessThanOrEqual(20);

    // The output starts after the mark: its first source frame does not show it.
    const first = frameAt(plan, 0).sourceMs ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(isMark(decoded[Math.round(first / DRIFT_FRAME_MS)])).toBe(false);
  });

  it('keeps the defaults when the mark is not in the video', async () => {
    // The same recording, told the mark was green: nothing matches.
    const runDir = path.join(parent, 'no-mark');
    await cp(customers, runDir, { recursive: true });
    const file = path.join(runDir, 'timeline.json');
    const timeline = JSON.parse(await readFile(file, 'utf8')) as {
      syncMark: { colour: string };
    };
    timeline.syncMark.colour = '#00ff00';
    await writeFile(file, JSON.stringify(timeline));
    const plan = await buildRenderPlan(runDir);
    expect(plan.offsetMeasured).toBe(false);
    expect(plan.offsetMs).toBe(DEFAULT_OFFSET_MS);
    expect(plan.maskLeadMs).toBe(200);
    expect(plan.timeMap[0].sourceStartMs).toBe(0);
  });
});
