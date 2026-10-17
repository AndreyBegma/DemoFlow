import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Box,
  type RenderOutput,
  type RunResult,
  RunResultSchema,
  type Timeline,
  TimelineSchema,
} from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  type FrameState,
  frameAt,
  frameCount,
  probeVideo,
  type RenderPlan,
  remotionRenderer,
  renderPath,
  runFfmpeg,
  toOutputMs,
} from '../../src/index.ts';
import { STYLE } from '../../src/remotion/style.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

if (!hasFfmpeg) {
  console.warn('no usable FFmpeg: skipping the Remotion renderer tests');
}

interface Rendered {
  runDir: string;
  plan: RenderPlan;
  output: RenderOutput;
  file: string;
}

describe.skipIf(!hasFfmpeg)('remotionRenderer on real runs', () => {
  let parent: string;
  const runs: Partial<Record<'customers' | 'failing' | 'login', Rendered>> = {};

  const rendered = (name: 'customers' | 'failing' | 'login'): Rendered => {
    const run = runs[name];
    if (run === undefined) throw new Error(`${name} was not rendered`);
    return run;
  };

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-remotion-'));
    for (const name of ['customers', 'failing', 'login'] as const) {
      const runDir = await recordFixtureRun(name, parent);
      const plan = await buildRenderPlan(runDir);
      const started = performance.now();
      const output = await remotionRenderer.render(runDir, plan);
      console.info(
        `remotion: ${name} rendered in ${Math.round(performance.now() - started)} ms, ${output.sizeBytes} bytes`,
      );
      runs[name] = {
        runDir,
        plan,
        output,
        file: renderPath(runDir, 'remotion'),
      };
    }
  }, 900_000);

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it.each([
    'customers',
    'failing',
  ] as const)('writes the %s MP4 at 1920×1080, 30 fps, H.264, yuv420p, faststart', async (name) => {
    const { file, plan } = rendered(name);
    const probe = await probeVideo(file);
    expect(probe).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
    });
    expect(probe.durationMs).toBeCloseTo(plan.durationMs, -2);
    // `+faststart`: the index comes before the media data.
    const bytes = await readFile(file);
    expect(bytes.indexOf('moov')).toBeGreaterThan(-1);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
  });

  it.each([
    'customers',
    'failing',
  ] as const)('lists the %s MP4 under renders[] and passes the rendering stage', async (name) => {
    const { runDir, output } = rendered(name);
    const result = await readResult(runDir);
    expect(result.renders).toEqual([output]);
    expect(output).toMatchObject({
      renderer: 'remotion',
      file: 'render/remotion.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
    });
    expect(result.stages.rendering.status).toBe('passed');
  });

  it('watermarks the failing MP4’s first and last frame and ends on the failure card', async () => {
    const { file, plan } = rendered('failing');
    const last = frameCount(plan) - 1;
    const first = await extractFrame(file, 0);
    const end = await extractFrame(file, last);

    // Inside the badge's padding, clear of its text.
    const badge = {
      x: plan.output.width - STYLE.watermark.marginPx - 6,
      y: STYLE.watermark.marginPx + 4,
    };
    const red = rgb(STYLE.watermark.fill);
    expect(colourDistance(first.pixel(badge), red)).toBeLessThan(40);
    expect(colourDistance(end.pixel(badge), red)).toBeLessThan(40);

    expect(frameAt(plan, last).endCard).toMatch(
      /^Verification failed at step 3: /,
    );
    // The fixture is dark, so the card's colour alone does not tell it from
    // the page: compare with the source. The first frame is the page…
    const source = path.join(rendered('failing').runDir, plan.source.file);
    const below = {
      x: 0,
      y: 120,
      width: plan.output.width,
      height: plan.output.height - 120,
    };
    const firstState = frameAt(plan, 0);
    const firstSource = await extractSourceFrame(source, firstState, plan);
    expect(first.fractionDiffering(firstSource, below, 32)).toBeLessThan(0.02);
    // …and the last is the card, not the last page frame.
    const cardStartMs = plan.failure?.endCard.startMs ?? 0;
    const lastPage = frameAt(
      plan,
      Math.ceil((cardStartMs * plan.output.fps) / 1000) - 1,
    );
    expect(lastPage.sourceMs).not.toBeNull();
    const lastSource = await extractSourceFrame(source, lastPage, plan);
    expect(end.fractionDiffering(lastSource, below, 32)).toBeGreaterThan(0.02);
    const card = rgb(STYLE.endCard.background);
    expect(colourDistance(end.pixel({ x: 40, y: 540 }), card)).toBeLessThan(6);
    expect(end.fractionNear(card, 6)).toBeGreaterThan(0.9);
  });

  it('covers the password field in every frame from the fill to the navigation', async () => {
    const { runDir, plan, file } = rendered('login');
    const timeline = await readTimeline(runDir);
    const index = timeline.events.findIndex((event) => event.masked === true);
    const password = timeline.events[index];
    // The click on "Sign in" navigates; the timeline does not mark it (#20, follow-up b).
    const navigation = timeline.events
      .slice(index + 1)
      .find((event) => event.action === 'click');
    const email = timeline.events
      .slice(0, index)
      .findLast((event) => event.action === 'fill');
    if (
      password?.target === undefined ||
      navigation === undefined ||
      email?.target === undefined
    ) {
      throw new Error('login timeline lacks the password, email or click');
    }

    const toOutput = (timelineMs: number): number =>
      toOutputMs(plan.timeMap, timelineMs + plan.offsetMs);
    const startMs = toOutput(password.startMs);
    const endMs = toOutput(navigation.endMs);
    expect(endMs - startMs).toBeGreaterThan(500);

    const source = path.join(runDir, plan.source.file);
    let samples = 0;
    for (let atMs = startMs; atMs < endMs; atMs += 500) {
      const frame = Math.round((atMs * plan.output.fps) / 1000);
      const state = frameAt(plan, frame);
      const rendered = await extractFrame(file, frame);
      const reference = await extractSourceFrame(source, state, plan);

      const box = toOutputBox(password.target.box, state, plan);
      const control = toOutputBox(email.target.box, state, plan);
      // The unmasked email field matches the source: the comparison is aligned.
      expect(rendered.fractionDiffering(reference, control, 32)).toBeLessThan(
        0.15,
      );
      // The password field does not.
      expect(rendered.fractionDiffering(reference, box, 32)).toBeGreaterThan(
        0.5,
      );
      samples += 1;
    }
    expect(samples).toBeGreaterThan(0);
  });

  it('marks the rendering stage failed when the source cannot be read', async () => {
    const { runDir, plan } = rendered('customers');
    const copy = path.join(parent, 'customers-broken');
    await cp(runDir, copy, { recursive: true });
    await expect(
      remotionRenderer.render(copy, {
        ...plan,
        source: { ...plan.source, file: 'missing.webm' },
      }),
    ).rejects.toThrow(/missing\.webm/);
    const result = await readResult(copy);
    expect(result.stages.rendering.status).toBe('failed');
    expect(result.stages.rendering.error?.message).toMatch(/missing\.webm/);
  });
});

async function readResult(runDir: string): Promise<RunResult> {
  return RunResultSchema.parse(
    JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')),
  );
}

async function readTimeline(runDir: string): Promise<Timeline> {
  return TimelineSchema.parse(
    JSON.parse(await readFile(path.join(runDir, 'timeline.json'), 'utf8')),
  );
}

type Rgb = [number, number, number];

/** One decoded frame, RGB, row-major. */
interface Picture {
  width: number;
  height: number;
  pixel(point: { x: number; y: number }): Rgb;
  fractionNear(colour: Rgb, tolerance: number): number;
  /** Of the pixels in `box`, the share where any channel differs from `other` by more than `threshold`. */
  fractionDiffering(other: Picture, box: Box, threshold: number): number;
}

function picture(bytes: Buffer, width: number, height: number): Picture {
  const at = (x: number, y: number): Rgb => {
    const offset = (Math.round(y) * width + Math.round(x)) * 3;
    return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
  };
  return {
    width,
    height,
    pixel: ({ x, y }) => at(x, y),
    fractionNear(colour, tolerance) {
      let near = 0;
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          if (colourDistance(at(x, y), colour) < tolerance) near += 1;
        }
      }
      return near / (Math.ceil(height / 4) * Math.ceil(width / 4));
    },
    fractionDiffering(other, box, threshold) {
      // A 2 px inset keeps resampling at the box's edge out of the count.
      const x0 = Math.ceil(box.x + 2);
      const y0 = Math.ceil(box.y + 2);
      const x1 = Math.floor(box.x + box.width - 2);
      const y1 = Math.floor(box.y + box.height - 2);
      let differing = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += 1;
          if (colourDistance(at(x, y), other.pixel({ x, y })) > threshold) {
            differing += 1;
          }
        }
      }
      if (total === 0) throw new Error('empty comparison box');
      return differing / total;
    },
  };
}

/** The largest per-channel difference. */
function colourDistance(a: Rgb, b: Rgb): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

function rgb(hex: string): Rgb {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((digit) => digit + digit)
      : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return digits.map((pair) => Number.parseInt(pair, 16)) as Rgb;
}

/** Output frame `index` of an MP4, decoded to RGB. */
async function extractFrame(file: string, index: number): Promise<Picture> {
  const probe = await probeVideo(file);
  const out = path.join(
    path.dirname(file),
    `frame-${index}-${process.pid}.rgb`,
  );
  await runFfmpeg([
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${index})`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    out,
  ]);
  const bytes = await readFile(out);
  await rm(out, { force: true });
  expect(bytes.length).toBe(probe.width * probe.height * 3);
  return picture(bytes, probe.width, probe.height);
}

/**
 * The unmasked source frame `state` shows, cropped and scaled the way the
 * frame places it, on an output-sized black canvas.
 */
async function extractSourceFrame(
  source: string,
  state: FrameState,
  plan: RenderPlan,
): Promise<Picture> {
  if (state.sourceMs === null) throw new Error('no source on an end card');
  const { crop, content } = state;
  const { width, height } = plan.output;
  const out = path.join(path.dirname(source), `source-${process.pid}.rgb`);
  await runFfmpeg([
    '-v',
    'error',
    '-y',
    '-ss',
    (Math.max(0, state.sourceMs) / 1000).toFixed(3),
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    [
      `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`,
      `scale=${Math.round(content.width)}:${Math.round(content.height)}`,
      `pad=${width}:${height}:${Math.round(content.x)}:${Math.round(content.y)}`,
    ].join(','),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    out,
  ]);
  const bytes = await readFile(out);
  await rm(out, { force: true });
  return picture(bytes, width, height);
}

/** A viewport CSS box where `state` draws it, in output pixels. */
function toOutputBox(box: Box, state: FrameState, plan: RenderPlan): Box {
  const viewX = state.crop.x / plan.source.scale;
  const viewY = state.crop.y / plan.source.scale;
  return {
    x: state.content.x + (box.x - viewX) * state.scale,
    y: state.content.y + (box.y - viewY) * state.scale,
    width: box.width * state.scale,
    height: box.height * state.scale,
  };
}
