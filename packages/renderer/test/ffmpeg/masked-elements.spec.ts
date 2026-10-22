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

/** Frames decoded per FFmpeg call: a 1080p RGB frame is 6 MB. */
const CHUNK = 15;

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
  expect(data.length).toBe(size * numbers.length);
  return numbers.map((_, i) => data.subarray(i * size, (i + 1) * size));
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
function showsText(frame: Uint8Array, width: number, region: Region): boolean {
  let dark = 0;
  let light = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const at = (y * width + x) * 3;
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
  width: number,
  region: Region,
): number {
  let difference = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const at = (y * width + x) * 3;
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

    const { width, fps } = plan.output;
    // A slow runner can deliver a video shorter than its timeline: only frames both files have.
    const total = Math.min(
      await countFrames(maskedFile),
      await countFrames(unmaskedFile),
    );
    const toFrame = (timelineMs: number): number =>
      Math.floor(
        (toOutputMs(plan.timeMap, timelineMs + plan.offsetMs) * fps) / 1000,
      );

    for (const [index, element] of elements.entries()) {
      const first = element.intervals[0];
      const last = element.intervals.at(-1);
      if (first === undefined || last === undefined) throw new Error('empty');
      // Neither element moves on this page: one box for every interval.
      for (const interval of element.intervals) {
        expect(Math.abs(interval.box.y - first.box.y)).toBeLessThanOrEqual(1);
      }
      // Half a second either side of the intervals, so an early edge would show.
      const from = Math.max(0, toFrame(first.startMs) - fps / 2);
      const to =
        last.endMs === undefined
          ? total
          : Math.min(total, toFrame(last.endMs) + fps / 2);
      const numbers = Array.from({ length: to - from }, (_, i) => from + i);
      let drawn = 0;
      for (let at = 0; at < numbers.length; at += CHUNK) {
        const chunk = numbers
          .slice(at, at + CHUNK)
          .filter((n) => frameAt(plan, n).sourceMs !== null);
        if (chunk.length === 0) continue;
        const masked = await extractFrames(maskedFile, chunk, plan);
        const unmasked = await extractFrames(unmaskedFile, chunk, plan);
        chunk.forEach((n, i) => {
          const region = regionOn(plan, n, first.box);
          if (region.x1 <= region.x0 || region.y1 <= region.y0) return;
          if (!showsText(unmasked[i], width, region)) return;
          drawn++;
          expect(
            meanDifference(masked[i], unmasked[i], width, region),
            `element ${index}, frame ${n}: drawn unblurred`,
          ).toBeGreaterThan(10);
        });
      }
      // The check saw the element, for longer than a blink.
      expect(drawn, `element ${index}`).toBeGreaterThan(fps / 3);
    }
  });
});
