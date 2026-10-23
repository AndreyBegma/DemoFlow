import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Box, CardsConfigSchema, TimelineSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawPlan } from '../../src/ffmpeg/pipeline.ts';
import {
  buildRenderPlan,
  ffmpegRenderer,
  frameAt,
  type RenderPlan,
  renderPath,
  runFfmpeg,
  toOutputMs,
} from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';
import { countFrames } from './sample-frames.ts';

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A crop of the output frame, in output pixels; even, as FFmpeg crops 4:2:0 video. */
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Decodes frames `numbers` of an MP4 to RGB24, in order, cropped to `crop`:
 * one pass over the file, a few rows of each frame rather than 6 MB of it.
 */
async function extractCropped(
  file: string,
  numbers: readonly number[],
  crop: Crop,
): Promise<Uint8Array[]> {
  const raw = `${file}.crop.rgb`;
  const select = numbers.map((n) => `eq(n\\,${n})`).join('+');
  await runFfmpeg([
    '-y',
    '-i',
    file,
    '-vf',
    `select=${select},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
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
  const size = crop.width * crop.height * 3;
  expect(data.length).toBe(size * numbers.length);
  return numbers.map((_, i) => data.subarray(i * size, (i + 1) * size));
}

/** The smallest even crop of the output that holds every region. */
function cropAround(regions: readonly Region[], plan: RenderPlan): Crop {
  const even = (n: number): number => 2 * Math.floor(n / 2);
  const x = even(Math.min(...regions.map((region) => region.x0)));
  const y = even(Math.min(...regions.map((region) => region.y0)));
  const x1 = Math.min(
    plan.output.width,
    even(Math.max(...regions.map((region) => region.x1)) + 1),
  );
  const y1 = Math.min(
    plan.output.height,
    even(Math.max(...regions.map((region) => region.y1)) + 1),
  );
  return { x, y, width: x1 - x, height: y1 - y };
}

/** The byte offset of output pixel (x, y) in a frame cropped to `crop`. */
function offsetIn(crop: Crop, x: number, y: number): number {
  return ((y - crop.y) * crop.width + (x - crop.x)) * 3;
}

/** `box` (viewport CSS pixels) in output pixels on frame `n`, a few pixels inside its edge. */
function regionOn(plan: RenderPlan, n: number, box: Box): Region {
  const { width, height } = plan.output;
  const state = frameAt(plan, n);
  const viewX = state.crop.x / plan.source.scale;
  const viewY = state.crop.y / plan.source.scale;
  return {
    x0: Math.max(
      0,
      Math.ceil(state.content.x + (box.x - viewX) * state.scale) + 3,
    ),
    y0: Math.max(
      0,
      Math.ceil(state.content.y + (box.y - viewY) * state.scale) + 3,
    ),
    x1: Math.min(
      width,
      Math.floor(state.content.x + (box.x + box.width - viewX) * state.scale) -
        3,
    ),
    y1: Math.min(
      height,
      Math.floor(state.content.y + (box.y + box.height - viewY) * state.scale) -
        3,
    ),
  };
}

/**
 * Whether the region shows the marked element: dark text on its white ground.
 * A card or the background is dark all over, a blank page white all over.
 */
function showsText(frame: Uint8Array, crop: Crop, region: Region): boolean {
  let dark = 0;
  let light = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const at = offsetIn(crop, x, y);
      const sum = frame[at] + frame[at + 1] + frame[at + 2];
      if (sum < 3 * 96) dark++;
      else if (sum > 3 * 200) light++;
    }
  }
  const area = (region.x1 - region.x0) * (region.y1 - region.y0);
  return dark / area >= 0.04 && light / area >= 0.3;
}

/** The mean per-channel difference of two frames inside the region. */
function meanDifference(
  a: Uint8Array,
  b: Uint8Array,
  crop: Crop,
  region: Region,
): number {
  let difference = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const at = offsetIn(crop, x, y);
      for (let c = 0; c < 3; c++) difference += Math.abs(a[at + c] - b[at + c]);
    }
  }
  return difference / ((region.x1 - region.x0) * (region.y1 - region.y0) * 3);
}

describe.skipIf(!hasFfmpeg)('data-demoflow-mask end to end (#197)', () => {
  let parent: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-marked-'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('never shows a marked element unblurred: every frame that draws it differs from the unmasked render inside its box', async () => {
    const runDir = await recordFixtureRun('masked-elements', parent);
    const timeline = TimelineSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'timeline.json'), 'utf8')),
    );
    // The API key, there from load; the balance, which a timer brings in mid-wait and a click removes.
    const elements = timeline.maskedElements ?? [];
    expect(elements).toHaveLength(2);

    // The default look: cards, the framed window, transitions — as #185.
    const plan = await buildRenderPlan(runDir, {
      cards: CardsConfigSchema.parse({}),
      transitions: { enabled: true, durationMs: 300 },
    });
    await ffmpegRenderer.render(runDir, plan);
    const maskedFile = renderPath(runDir, 'ffmpeg');
    const unmaskedFile = path.join(runDir, 'render', 'unmasked.mp4');
    await drawPlan(
      path.join(runDir, plan.source.file),
      {
        ...plan,
        masks: [],
        ...(plan.transitions === undefined
          ? {}
          : {
              transitions: {
                ...plan.transitions,
                holds: plan.transitions.holds.map((hold) => ({
                  ...hold,
                  masks: [],
                })),
              },
            }),
      },
      [unmaskedFile],
    );

    const { fps } = plan.output;
    // A slow runner can deliver a video shorter than its timeline: only frames both files have.
    const total = Math.min(
      await countFrames(maskedFile),
      await countFrames(unmaskedFile),
    );
    const toFrame = (timelineMs: number): number =>
      Math.floor(
        (toOutputMs(plan.timeMap, timelineMs + plan.offsetMs) * fps) / 1000,
      );

    // Each element's frames: half a second either side of its intervals, so an early edge would show.
    const checks: Array<{ element: number; n: number; region: Region }> = [];
    for (const [index, element] of elements.entries()) {
      const first = element.intervals[0];
      const last = element.intervals.at(-1);
      if (first === undefined || last === undefined) throw new Error('empty');
      // Neither element moves on this page: one box for every interval.
      for (const interval of element.intervals) {
        expect(Math.abs(interval.box.y - first.box.y)).toBeLessThanOrEqual(1);
      }
      const from = Math.max(0, toFrame(first.startMs) - fps / 2);
      const to =
        last.endMs === undefined
          ? total
          : Math.min(total, toFrame(last.endMs) + fps / 2);
      for (let n = from; n < to; n++) {
        if (frameAt(plan, n).sourceMs === null) continue;
        const region = regionOn(plan, n, first.box);
        if (region.x1 <= region.x0 || region.y1 <= region.y0) continue;
        checks.push({ element: index, n, region });
      }
    }
    const numbers = [...new Set(checks.map((check) => check.n))].sort(
      (a, b) => a - b,
    );
    const crop = cropAround(
      checks.map((check) => check.region),
      plan,
    );
    const masked = await extractCropped(maskedFile, numbers, crop);
    const unmasked = await extractCropped(unmaskedFile, numbers, crop);

    const drawn = elements.map(() => 0);
    for (const { element, n, region } of checks) {
      const i = numbers.indexOf(n);
      if (!showsText(unmasked[i], crop, region)) continue;
      drawn[element]++;
      expect(
        meanDifference(masked[i], unmasked[i], crop, region),
        `element ${element}, frame ${n}: drawn unblurred`,
      ).toBeGreaterThan(10);
    }
    // The check saw each element, for longer than a blink.
    for (const count of drawn) expect(count).toBeGreaterThan(fps / 3);
  });
});
