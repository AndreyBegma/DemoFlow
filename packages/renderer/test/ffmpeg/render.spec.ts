import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunResultSchema, type TimelineEvent } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOOK } from '../../src/ffmpeg/compose.ts';
import { wrapText } from '../../src/ffmpeg/font.ts';
import { drawPlan } from '../../src/ffmpeg/pipeline.ts';
import {
  buildRenderPlan,
  ffmpegRenderer,
  frameAt,
  frameCount,
  probeVideo,
  type RenderPlan,
  renderPath,
  runFfmpeg,
  toOutputMs,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

// A Windows CI runner records and renders the customers run in 108 s of the default 120.
vi.setConfig({ testTimeout: 240_000 });

if (!hasFfmpeg) {
  console.warn('no usable FFmpeg: skipping the FFmpeg compositor tests');
}

/** Decodes frames `numbers` of an MP4 to RGB24, in order. */
async function extractFrames(
  file: string,
  numbers: readonly number[],
  plan: RenderPlan,
): Promise<Uint8Array[]> {
  const raw = `${file}.${numbers[0]}.rgb`;
  const select = numbers.map((n) => `eq(n\\,${n})`).join('+');
  await runFfmpeg([
    '-y',
    '-i',
    file,
    '-vf',
    `select=${select}`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    raw,
  ]);
  const data = await readFile(raw);
  await rm(raw);
  const size = plan.output.width * plan.output.height * 3;
  expect(
    data.length,
    `${path.basename(file)}: frames ${numbers.join(',')} of ${frameCount(plan)}`,
  ).toBe(size * numbers.length);
  return numbers.map((_, i) => data.subarray(i * size, (i + 1) * size));
}

function rgb(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 3;
  return [frame[at], frame[at + 1], frame[at + 2]];
}

async function readResult(runDir: string) {
  return RunResultSchema.parse(
    JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')),
  );
}

async function readEvents(runDir: string): Promise<TimelineEvent[]> {
  const timeline = JSON.parse(
    await readFile(path.join(runDir, 'timeline.json'), 'utf8'),
  ) as { events: TimelineEvent[] };
  return timeline.events;
}

describe.skipIf(!hasFfmpeg)('the FFmpeg compositor on real runs', () => {
  let parent: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-ffmpeg-'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  for (const scenario of ['customers', 'failing'] as const) {
    it(`renders the ${scenario} run to a 1920×1080, 30 fps H.264 MP4 listed in renders[]`, async () => {
      const runDir = await recordFixtureRun(scenario, parent);
      const plan = await buildRenderPlan(runDir);
      const output = await ffmpegRenderer.render(runDir, plan);

      expect(output).toMatchObject({
        renderer: 'ffmpeg',
        file: 'render/ffmpeg.mp4',
        width: 1920,
        height: 1080,
        fps: 30,
      });
      const file = renderPath(runDir, 'ffmpeg');
      const probe = await probeVideo(file);
      expect(probe).toMatchObject({
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        pixelFormat: 'yuv420p',
      });
      expect(probe.durationMs).toBeCloseTo(plan.durationMs, -2);
      // BT.709, limited range and tagged in the stream.
      // `ffmpeg-static` ships no `ffprobe`; FFmpeg's stream line says the same.
      const { stderr } = await runFfmpeg([
        '-i',
        file,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      expect(stderr).toMatch(/Video: h264 [^\n]*yuv420p\(tv, bt709[,)]/);
      const result = await readResult(runDir);
      expect(result.renders).toContainEqual(output);
      expect(result.stages.rendering.status).toBe('passed');

      if (scenario !== 'failing') return;
      // The watermark on the first and the last frame; the last is the end card.
      const last = frameCount(plan) - 1;
      expect(frameAt(plan, last).endCard).toBeDefined();
      const [first, end] = await extractFrames(file, [0, last], plan);
      const { width } = plan.output;
      const badge = { x: width - LOOK.watermark.margin - 6, y: 24 + 32 };
      for (const frame of [first, end]) {
        const [r, g, b] = rgb(frame, width, badge.x, badge.y);
        expect(r).toBeGreaterThan(190);
        expect(g).toBeLessThan(80);
        expect(b).toBeLessThan(80);
      }
      // The card: #111 around white text in the middle.
      for (const channel of rgb(end, width, 100, 540)) {
        expect(Math.abs(channel - 0x11)).toBeLessThan(8);
      }
      let white = 0;
      for (let y = 440; y < 640; y++) {
        for (let x = 0; x < width; x++) {
          if (rgb(end, width, x, y)[0] > 220) white++;
        }
      }
      expect(white).toBeGreaterThan(1000);

      // The end card text fits within 1600 px, in no more lines than when the
      // sizes were read as cap heights (a font size of 48 / 0.72 draws those).
      const text = frameAt(plan, last).endCard ?? '';
      const style = LOOK.endCard.text;
      const lines = wrapText(text, style, LOOK.endCard.maxWidth);
      const before = wrapText(
        text,
        { fontPx: 48 / 0.72, weight: style.weight },
        LOOK.endCard.maxWidth,
      );
      expect(lines.length).toBeLessThanOrEqual(before.length);
      let left = width;
      let right = 0;
      for (let y = 100; y < 1000; y++) {
        for (let x = 0; x < width; x++) {
          if (rgb(end, width, x, y)[0] > 200) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      expect(right).toBeGreaterThan(left);
      expect(right - left + 1).toBeLessThanOrEqual(LOOK.endCard.maxWidth);
    });
  }

  it('covers the password field on every frame until the navigation (login)', async () => {
    const runDir = await recordFixtureRun('login', parent);
    const plan = await buildRenderPlan(runDir);
    await ffmpegRenderer.render(runDir, plan);
    const unmaskedFile = path.join(runDir, 'render', 'unmasked.mp4');
    await drawPlan(
      path.join(runDir, plan.source.file),
      { ...plan, masks: [] },
      unmaskedFile,
    );

    const events = await readEvents(runDir);
    const passwordIndex = events.findIndex((event) => event.masked === true);
    const password = events[passwordIndex];
    const navigation = events
      .slice(passwordIndex + 1)
      .find((event) => event.action === 'click');
    const box = password?.target?.box;
    if (password === undefined || navigation === undefined || !box) {
      throw new Error('login has no masked fill followed by a click');
    }
    const toFrame = (timelineMs: number): number =>
      Math.floor(
        (toOutputMs(plan.timeMap, timelineMs + plan.offsetMs) *
          plan.output.fps) /
          1000,
      );
    const from = toFrame(password.startMs);
    // A slow runner can deliver a video that ends before the timeline does
    // (the same run measures shorter than its events); only frames the render
    // has can be checked.
    const to = Math.min(toFrame(navigation.endMs), frameCount(plan));
    // A frame every 500 ms (15 at 30 fps), and the last one before the navigation.
    const numbers: number[] = [];
    for (let n = from; n < to; n += plan.output.fps / 2) numbers.push(n);
    numbers.push(to - 1);
    expect(numbers.length).toBeGreaterThan(2);

    const masked = await extractFrames(
      renderPath(runDir, 'ffmpeg'),
      numbers,
      plan,
    );
    const unmasked = await extractFrames(unmaskedFile, numbers, plan);
    const { width } = plan.output;
    numbers.forEach((n, i) => {
      const state = frameAt(plan, n);
      const viewX = state.crop.x / plan.source.scale;
      const viewY = state.crop.y / plan.source.scale;
      // The field in output pixels, a few pixels inside its edge.
      const x0 = Math.ceil(state.content.x + (box.x - viewX) * state.scale) + 3;
      const y0 = Math.ceil(state.content.y + (box.y - viewY) * state.scale) + 3;
      const x1 =
        Math.floor(
          state.content.x + (box.x + box.width - viewX) * state.scale,
        ) - 3;
      const y1 =
        Math.floor(
          state.content.y + (box.y + box.height - viewY) * state.scale,
        ) - 3;
      expect(x1 > x0 && y1 > y0, `frame ${n}: the box is on screen`).toBe(true);
      let difference = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = rgb(masked[i], width, x, y);
          const b = rgb(unmasked[i], width, x, y);
          difference +=
            Math.abs(a[0] - b[0]) +
            Math.abs(a[1] - b[1]) +
            Math.abs(a[2] - b[2]);
        }
      }
      const mean = difference / ((x1 - x0) * (y1 - y0) * 3);
      expect(
        mean,
        `frame ${n}: the field differs from the unmasked render`,
      ).toBeGreaterThan(10);
    });
  });
});
