/// <reference lib="dom" />
// The DOM lib: `page-frames.ts` holds page-side functions (temporary file).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CardsConfigSchema, TimelineSchema } from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import { pageFrames } from '../../../engine/test/execute/page-frames.ts';
import {
  buildRenderPlan,
  frameAt,
  frameCount,
  type RenderPlan,
  toOutputMs,
  toSourceMs,
} from '../../src/index.ts';
import { runFfmpegRaw } from '../../src/plan/ffmpeg.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

// TEMPORARY (#185 diagnosis): removed before the pull request.

const RUNS = Number(process.env.DEMOFLOW_MASK_DIAG_RUNS ?? '5');

/** Source frames inside `box`, each judged against the last source frame. */
async function sourceShows(
  file: string,
  plan: RenderPlan,
  box: { x: number; y: number; width: number; height: number },
): Promise<{ atMs: number; shown: boolean; diff: number }[]> {
  const { scale, width, height } = plan.source;
  const even = (n: number): number => 2 * Math.floor(n / 2);
  const x = even(Math.max(0, Math.ceil(box.x * scale) + 4));
  const y = even(Math.max(0, Math.ceil(box.y * scale) + 4));
  const w = even(
    Math.min(width, Math.floor((box.x + box.width) * scale) - 3) - x,
  );
  const h = even(
    Math.min(height, Math.floor((box.y + box.height) * scale) - 3) - y,
  );
  const { stdout, stderr } = await runFfmpegRaw([
    '-i',
    file,
    '-vf',
    `crop=${w}:${h}:${x}:${y},showinfo`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  const times = [
    ...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*\d+\s+pts_time:([\d.]+)/g),
  ].map((match) => Number(match[1]) * 1000);
  const size = w * h * 3;
  const last = stdout.subarray((times.length - 1) * size);
  return times.map((atMs, i) => {
    const frame = stdout.subarray(i * size, (i + 1) * size);
    let difference = 0;
    for (let at = 0; at < size; at++) {
      difference += Math.abs(frame[at] - last[at]);
    }
    return { atMs, shown: difference / size > 8, diff: difference / size };
  });
}

describe.skipIf(!hasFfmpeg || process.env.DEMOFLOW_MASK_DIAG !== '1')(
  '#185 diagnosis: login mask end against the source frames',
  () => {
    it(`measures ${RUNS} login runs`, { timeout: 600_000 }, async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'demoflow-diag-'));
      const rows: Record<string, unknown>[] = [];
      for (let run = 0; run < RUNS; run++) {
        const probe = pageFrames('login-password');
        const runDir = await recordFixtureRun(
          'login',
          path.join(parent, String(run)),
          [probe.observer],
        );
        const timeline = TimelineSchema.parse(
          JSON.parse(
            await readFile(path.join(runDir, 'timeline.json'), 'utf8'),
          ),
        );
        const plan = await buildRenderPlan(runDir, {
          cards: CardsConfigSchema.parse({}),
          transitions: { enabled: true, durationMs: 300 },
        });
        const events = timeline.events;
        const password = events.find((event) => event.masked === true);
        const signIn = events.find((event) => event.action === 'click');
        const box = password?.target?.box;
        const interval = password?.maskVisibility?.[0];
        if (!password || !signIn || !box || interval?.endMs === undefined) {
          rows.push({ run, error: 'no masked fill, click or closed interval' });
          continue;
        }
        const edgeMs = interval.endMs;

        // The page's own edge: the first frame drawn without the field.
        const read = probe.reads.get(signIn.stepIndex);
        let pageEdge: { minMs: number; maxMs: number } | undefined;
        if (read !== undefined) {
          const frames = read.frames;
          let lastShown = -1;
          frames.forEach(([, shown], i) => {
            if (shown) lastShown = i;
          });
          const gone = frames[lastShown + 1];
          if (gone !== undefined) {
            const zero = probe.zeroMs();
            pageEdge = {
              minMs: gone[0] + read.shift.minMs - zero,
              maxMs: gone[0] + read.shift.maxMs - zero,
            };
          }
        }

        const source = await sourceShows(
          path.join(runDir, plan.source.file),
          plan,
          box,
        );
        const near = (timelineMs: number) => timelineMs + plan.offsetMs;
        const lastShown = source
          .filter((frame) => frame.atMs <= near(signIn.endMs) + 1000)
          .findLast((frame) => frame.shown);
        const firstGone = source.find(
          (frame) => lastShown !== undefined && frame.atMs > lastShown.atMs,
        );
        // The span that holds the click.
        const clickOut = toOutputMs(plan.timeMap, near(signIn.startMs));
        const span = plan.masks.find(
          (mask) => mask.startMs <= clickOut && mask.endMs > clickOut,
        );
        const spanEndSourceMs =
          span === undefined ? undefined : toSourceMs(plan.timeMap, span.endMs);

        // The render test's own verdict, frame by frame.
        const fps = plan.output.fps;
        const toFrame = (timelineMs: number): number =>
          Math.floor((toOutputMs(plan.timeMap, near(timelineMs)) * fps) / 1000);
        const shows = (sourceMs: number): boolean => {
          const next = source.findIndex((frame) => frame.atMs > sourceMs);
          const at = next === -1 ? source.length - 1 : Math.max(0, next - 1);
          return source[at].shown || (source[next]?.shown ?? false);
        };
        const leaks: number[] = [];
        const to = Math.min(toFrame(signIn.endMs) + fps / 2, frameCount(plan));
        for (let n = toFrame(signIn.startMs); n < to; n++) {
          const state = frameAt(plan, n);
          if (state.sourceMs === null) continue;
          if (shows(state.sourceMs) && state.masks.length === 0) leaks.push(n);
        }

        const goneMs = firstGone?.atMs;
        rows.push({
          run,
          offsetMs: plan.offsetMs,
          offMs: timeline.syncMark?.offMs,
          trailMs: plan.maskTrailMs,
          upToStepEndMs: signIn.endMs - edgeMs,
          watchEdgeMs: edgeMs,
          pageEdgeMinMs: pageEdge?.minMs,
          pageEdgeMaxMs: pageEdge?.maxMs,
          watchMinusPageMaxMs:
            pageEdge === undefined ? undefined : edgeMs - pageEdge.maxMs,
          mappedEdgeSourceMs: edgeMs + plan.offsetMs,
          lastShownSourceMs: lastShown?.atMs,
          firstGoneSourceMs: goneMs,
          lagMs:
            goneMs === undefined
              ? undefined
              : goneMs - (edgeMs + plan.offsetMs),
          spanEndSourceMs,
          marginMs:
            goneMs === undefined || spanEndSourceMs === undefined
              ? undefined
              : spanEndSourceMs - goneMs,
          diffs: source
            .filter(
              (frame) =>
                frame.atMs >= edgeMs + plan.offsetMs - 120 &&
                frame.atMs <= edgeMs + plan.offsetMs + 200,
            )
            .map((frame) => `${frame.atMs.toFixed(0)}:${frame.diff.toFixed(1)}`)
            .join(' '),
          leakFrames: leaks,
        });
        console.log(`MASKDIAG ${JSON.stringify(rows.at(-1))}`);
      }
      expect(rows.length).toBe(RUNS);
    });
  },
);
