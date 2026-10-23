// TEMPORARY (#221): diagnostics for the marked-mask leak. Removed before the PR is ready.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Box, CardsConfigSchema, TimelineSchema } from '@demoflow/core';
import { afterAll, beforeAll, describe, it } from 'vitest';
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

async function frames(
  file: string,
  numbers: readonly number[],
  width: number,
  height: number,
): Promise<Uint8Array[]> {
  const raw = `${file}.diag.rgb`;
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
  const size = width * height * 3;
  return numbers.map((_, i) => data.subarray(i * size, (i + 1) * size));
}

function regionOn(plan: RenderPlan, n: number, box: Box): Region {
  const state = frameAt(plan, n);
  const viewX = state.crop.x / plan.source.scale;
  const viewY = state.crop.y / plan.source.scale;
  return {
    x0: Math.ceil(state.content.x + (box.x - viewX) * state.scale) + 3,
    y0: Math.ceil(state.content.y + (box.y - viewY) * state.scale) + 3,
    x1:
      Math.floor(state.content.x + (box.x + box.width - viewX) * state.scale) -
      3,
    y1:
      Math.floor(state.content.y + (box.y + box.height - viewY) * state.scale) -
      3,
  };
}

function stats(
  frame: Uint8Array,
  width: number,
  r: Region,
): { dark: number; light: number } {
  let dark = 0;
  let light = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const at = (y * width + x) * 3;
      const sum = frame[at] + frame[at + 1] + frame[at + 2];
      if (sum < 3 * 96) dark++;
      else if (sum > 3 * 200) light++;
    }
  }
  const area = (r.x1 - r.x0) * (r.y1 - r.y0);
  return {
    dark: Math.round((dark / area) * 1000) / 1000,
    light: Math.round((light / area) * 1000) / 1000,
  };
}

function diff(a: Uint8Array, b: Uint8Array, width: number, r: Region): number {
  let d = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const at = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) d += Math.abs(a[at + c] - b[at + c]);
    }
  }
  return Math.round((d / ((r.x1 - r.x0) * (r.y1 - r.y0) * 3)) * 10) / 10;
}

const RUNS = Number(process.env.DIAG_221_RUNS ?? 1);

describe.skipIf(!hasFfmpeg || process.env.DIAG_221 === undefined)(
  'diag #221',
  () => {
    let parent: string;
    beforeAll(async () => {
      parent = await mkdtemp(path.join(tmpdir(), 'demoflow-diag-'));
    });
    afterAll(async () => {
      await rm(parent, { recursive: true, force: true });
    });

    for (let run = 0; run < RUNS; run++) {
      it(`run ${run}`, { timeout: 300_000 }, async () => {
        const runDir = await recordFixtureRun(
          'masked-elements',
          path.join(parent, `r${run}`),
        );
        const timeline = TimelineSchema.parse(
          JSON.parse(await readFile(path.join(runDir, 'timeline.json'), 'utf8')),
        );
        const elements = timeline.maskedElements ?? [];
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
        const { fps, width, height } = plan.output;
        const total = Math.min(
          await countFrames(maskedFile),
          await countFrames(unmaskedFile),
        );
        const toFrame = (timelineMs: number): number =>
          Math.floor(
            (toOutputMs(plan.timeMap, timelineMs + plan.offsetMs) * fps) / 1000,
          );
        const report: Record<string, unknown> = {
          run,
          offsetMs: plan.offsetMs,
          offsetMeasured: plan.offsetMeasured,
          lead: plan.maskLeadMs,
          trail: plan.maskTrailMs,
          sourceFps: plan.source.fps,
          syncMark: timeline.syncMark,
          timeMap: plan.timeMap.slice(0, 4),
          cards: plan.cards,
          holds: plan.transitions?.holds,
          steps: timeline.events.map((e) => [e.action, e.startMs, e.endMs]),
          navigations: timeline.navigations,
          elements,
          spans: plan.masks,
          total,
        };
        const rows: unknown[] = [];
        for (const [index, element] of elements.entries()) {
          const first = element.intervals[0];
          const last = element.intervals.at(-1);
          if (first === undefined || last === undefined) continue;
          const from = Math.max(0, toFrame(first.startMs) - fps);
          const to =
            last.endMs === undefined
              ? Math.min(total, toFrame(first.startMs) + 2 * fps)
              : Math.min(total, toFrame(last.endMs) + fps);
          const numbers: number[] = [];
          for (let n = from; n < to; n++) numbers.push(n);
          const masked = await frames(maskedFile, numbers, width, height);
          const unmasked = await frames(unmaskedFile, numbers, width, height);
          for (const [i, n] of numbers.entries()) {
            const state = frameAt(plan, n);
            const r = regionOn(plan, n, first.box);
            if (state.sourceMs === null) continue;
            const s = stats(unmasked[i], width, r);
            const text = s.dark >= 0.04 && s.light >= 0.3;
            const d = diff(masked[i], unmasked[i], width, r);
            rows.push(
              `${text && d <= 10 ? 'LEAK ' : ''}e${index} n${n} tl${Math.round(
                state.sourceMs - plan.offsetMs,
              )} m${state.masks.length} f${
                state.fade === undefined
                  ? '-'
                  : Math.round(state.fade.progress * 100)
              } ${text ? 'T' : '.'} d${d}`,
            );
          }
        }
        report.rows = rows;
        process.stderr.write(`\nDIAG221 ${JSON.stringify(report)}\n`);
      });
    }
  },
);
