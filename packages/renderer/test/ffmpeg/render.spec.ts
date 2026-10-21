import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  CardsConfigSchema,
  RunResultSchema,
  type TimelineEvent,
  TimelineSchema,
} from '@demoflow/core';
import type { EngineObserver } from '@demoflow/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOK, renderStage } from '../../src/ffmpeg/compose.ts';
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
import { runFfmpegRaw } from '../../src/plan/ffmpeg.ts';
import {
  hasFfmpeg,
  recordFixtureRun,
  recordInlineRun,
} from '../plan/fixture-runs.ts';
import {
  checkFramedLayout,
  checkLayout,
  type LayoutReport,
} from '../visual/layout.ts';
import { countFrames, sampleFrames } from './sample-frames.ts';

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

/** The frame nearest `around` on which the camera shows the whole stage. */
function unzoomedNear(plan: RenderPlan, around: number): number {
  const frames = frameCount(plan);
  for (let distance = 0; distance < frames; distance++) {
    for (const frame of [around - distance, around + distance]) {
      if (frame < 0 || frame >= frames) continue;
      const view = frameAt(plan, frame).frame?.view;
      if (
        view?.width === plan.output.width &&
        frameAt(plan, frame).sourceMs !== null
      ) {
        return frame;
      }
    }
  }
  throw new Error('the camera never shows the whole stage');
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

/**
 * Whether the source video shows something inside `box` (viewport pixels,
 * a few pixels inside its edge), frame by frame, judged against the last
 * source frame: for a field the run removed, the page without it.
 */
async function sourceShows(
  runDir: string,
  plan: RenderPlan,
  box: { x: number; y: number; width: number; height: number },
): Promise<{ atMs: number; shown: boolean }[]> {
  const { scale, width, height } = plan.source;
  // Even, as a crop of 4:2:0 video is: FFmpeg rounds an odd one.
  const even = (n: number): number => 2 * Math.floor(n / 2);
  const x = even(Math.max(0, Math.ceil(box.x * scale) + 4));
  const y = even(Math.max(0, Math.ceil(box.y * scale) + 4));
  const w = even(
    Math.min(width, Math.floor((box.x + box.width) * scale) - 3) - x,
  );
  const h = even(
    Math.min(height, Math.floor((box.y + box.height) * scale) - 3) - y,
  );
  expect(w > 0 && h > 0, 'the box is inside the source').toBe(true);
  const { stdout, stderr } = await runFfmpegRaw([
    '-i',
    path.join(runDir, plan.source.file),
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
  // One `n: … pts_time:` line per frame shown.
  const times = [
    ...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*\d+\s+pts_time:([\d.]+)/g),
  ].map((match) => Number(match[1]) * 1000);
  const size = w * h * 3;
  expect(stdout.length).toBe(size * times.length);
  const last = stdout.subarray((times.length - 1) * size);
  return times.map((atMs, i) => {
    const frame = stdout.subarray(i * size, (i + 1) * size);
    let difference = 0;
    for (let at = 0; at < size; at++) {
      difference += Math.abs(frame[at] - last[at]);
    }
    return { atMs, shown: difference / size > 8 };
  });
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

  // `customers` renders the default, framed look; `failing` turns the frame
  // off, so the full-bleed path stays covered end to end.
  for (const scenario of ['customers', 'failing'] as const) {
    it(`renders the ${scenario} run to a 1920×1080, 30 fps H.264 MP4 listed in renders[]`, async () => {
      const runDir = await recordFixtureRun(scenario, parent);
      const plan = await buildRenderPlan(
        runDir,
        scenario === 'failing' ? { frame: { enabled: false } } : {},
      );
      expect(plan.frame === undefined).toBe(scenario === 'failing');
      const outputs = await ffmpegRenderer.render(runDir, plan);
      // No `formats`: the MP4 alone, as before spec 133.
      expect(outputs).toHaveLength(1);
      const [output] = outputs;

      expect(output).toMatchObject({
        renderer: 'ffmpeg',
        format: 'mp4',
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

      // The sync mark is trimmed (#19): the first output frames hold none of its magenta.
      const opening = await extractFrames(
        file,
        Array.from({ length: 10 }, (_, n) => n),
        plan,
      );
      for (const [n, frame] of opening.entries()) {
        let magenta = 0;
        for (let at = 0; at < frame.length; at += 3) {
          if (frame[at] > 200 && frame[at + 1] < 100 && frame[at + 2] > 200) {
            magenta++;
          }
        }
        expect(magenta, `output frame ${n}`).toBe(0);
      }

      // The layout (#47): a mid-run frame has page content in every quadrant
      // and no large block of the recorder's padding grey — of the window
      // when framed, with the background outside it (spec 100).
      const stage = renderStage(plan);
      const middleFrame =
        stage === undefined
          ? Math.floor(frameCount(plan) / 2)
          : unzoomedNear(plan, Math.floor(frameCount(plan) / 2));
      const [middle] = await extractFrames(file, [middleFrame], plan);
      const layout: LayoutReport & { backgroundDelta?: number } =
        stage === undefined
          ? checkLayout(middle, plan.output.width, plan.output.height)
          : checkFramedLayout(
              middle,
              plan.output.width,
              plan.output.height,
              frameAt(plan, middleFrame).content,
              stage.data,
            );
      console.info(
        `layout ${scenario}: quadrant ranges ${layout.quadrantRanges.join('/')}, ` +
          `padding ${(layout.paddingShare * 100).toFixed(1)} %` +
          (layout.backgroundDelta === undefined
            ? ''
            : `, background delta ${layout.backgroundDelta.toFixed(2)}`),
      );
      expect(layout.problems, `${scenario}: frame ${middleFrame}`).toEqual([]);

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

  it('renders the cards of a real run: intro, a scene card, the outro (customers)', async () => {
    const runDir = await recordFixtureRun(
      'customers',
      path.join(parent, 'cards'),
    );
    const plain = await buildRenderPlan(runDir, {
      cards: CardsConfigSchema.parse({
        intro: { enabled: false },
        scenes: { enabled: false },
      }),
    });
    const plan = await buildRenderPlan(runDir, {
      cards: CardsConfigSchema.parse({
        outro: { title: 'Acme', cta: 'acme.dev/try' },
      }),
      scenario: { description: 'Find a customer and open their record' },
    });
    expect(plan.cards.map((card) => card.kind)).toEqual([
      'intro',
      'scene',
      'outro',
    ]);
    expect(plan.durationMs).toBeCloseTo(plain.durationMs + 6000, 6);
    await ffmpegRenderer.render(runDir, plan);
    const file = renderPath(runDir, 'ffmpeg');
    expect((await probeVideo(file)).durationMs).toBeCloseTo(
      plan.durationMs,
      -2,
    );

    const { fps, width } = plan.output;
    const [intro, scene, outro] = plan.cards;
    // The first frame at or after `ms`: a real run's cards sit off the frame grid.
    const frameOf = (ms: number): number => Math.ceil((ms * fps) / 1000 - 1e-6);
    const last = frameCount(plan) - 1;
    const beforeScene = frameOf(scene.startMs) - 1;
    const afterScene = frameOf(scene.startMs + scene.durationMs);
    expect(frameAt(plan, 0).card?.title).toBe(intro.title);
    expect(frameAt(plan, frameOf(scene.startMs)).card?.title).toBe('Customers');
    expect(frameAt(plan, last).card?.title).toBe(outro.title);
    expect(frameAt(plan, beforeScene).sourceMs).not.toBeNull();
    expect(frameAt(plan, afterScene).sourceMs).not.toBeNull();

    const [first, before, onScene, after, end] = await extractFrames(
      file,
      [0, beforeScene, frameOf(scene.startMs) + 10, afterScene, last],
      plan,
    );
    // Cards: the background, with light text in the middle.
    for (const card of [first, onScene, end]) {
      let white = 0;
      for (let y = 440; y < 640; y++) {
        for (let x = 0; x < width; x++) {
          if (rgb(card, width, x, y).every((c) => c > 220)) white++;
        }
      }
      expect(white).toBeGreaterThan(500);
    }
    // The page pauses on the cut and resumes there: either side of the scene
    // card is the frame the run without cards shows at that page time. The
    // cards ahead are 60 and 105 frames long (2 000 and 3 500 ms at 30 fps).
    // As the plan draws it: the same source frame. The camera may differ by
    // a pixel or so — a move cut by the card eases into the cut and out of it.
    for (const [carded, without] of [
      [beforeScene, beforeScene - 60],
      [afterScene, afterScene - 105],
    ]) {
      expect(frameAt(plan, carded).sourceMs).toBeCloseTo(
        frameAt(plain, without).sourceMs ?? Number.NaN,
        6,
      );
    }
    const plainFile = path.join(runDir, 'render', 'plain.mp4');
    await drawPlan(path.join(runDir, plain.source.file), plain, [plainFile]);
    const [plainBefore, plainAfter] = await extractFrames(
      plainFile,
      [beforeScene - 60, afterScene - 105],
      plain,
    );
    for (const [name, carded, without] of [
      ['before', before, plainBefore],
      ['after', after, plainAfter],
    ] as const) {
      let difference = 0;
      for (let at = 0; at < carded.length; at++) {
        difference += Math.abs(carded[at] - without[at]);
      }
      const mean = difference / carded.length;
      console.info(`scene card: ${name} the cut, mean difference ${mean}`);
      // Measured 0.4–2.3 locally and 5.11 once on CI: two separate x264
      // encodes of the same frame (the plan states match exactly, above).
      // The neighbouring source frame, mid page load, measured 193.
      expect(mean, `${name} the scene card`).toBeLessThan(20);
    }
  });

  it('covers the password field on every frame it shows, and drops the box soon after the form leaves (login)', async () => {
    const runDir = await recordFixtureRun('login', parent);
    // With the default cards (spec 108): the intro moves every page frame.
    // With the default transitions (spec 114): every hold and dissolve too.
    const plan = await buildRenderPlan(runDir, {
      cards: CardsConfigSchema.parse({}),
      transitions: { enabled: true, durationMs: 300 },
    });
    expect(plan.cards.map((card) => card.kind)).toEqual(['intro']);
    expect(plan.transitions?.holds.length).toBeGreaterThan(0);
    await ffmpegRenderer.render(runDir, plan);
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
    const { width, height, fps } = plan.output;
    // The default plan is framed (spec 100): the field moves with the window.
    expect(plan.frame).toBeDefined();
    /** The field in output pixels on frame `n`, a few pixels inside its edge. */
    const fieldOn = (n: number) => {
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
          Math.floor(
            state.content.x + (box.x + box.width - viewX) * state.scale,
          ) - 3,
        ),
        y1: Math.min(
          height,
          Math.floor(
            state.content.y + (box.y + box.height - viewY) * state.scale,
          ) - 3,
        ),
      };
    };

    // #155: signing in removes the form on the same page. On every output
    // frame around the click, the source frame it draws (or the next one, the
    // stricter reading) either lacks the field or has a mask over it; and the
    // mask is gone at most 300 ms after the first frame without the field.
    const source = await sourceShows(runDir, plan, box);
    const showsField = (sourceMs: number): boolean => {
      const next = source.findIndex((frame) => frame.atMs > sourceMs);
      const at = next === -1 ? source.length - 1 : Math.max(0, next - 1);
      return source[at].shown || (source[next]?.shown ?? false);
    };
    // A slow runner can deliver a video that ends before the timeline does
    // (the same run measures shorter than its events); only frames the
    // rendered file has can be checked.
    const maskedFile = renderPath(runDir, 'ffmpeg');
    const frames = await countFrames(maskedFile);
    const around = {
      from: toFrame(navigation.startMs),
      to: Math.min(toFrame(navigation.endMs) + fps / 2, frames),
    };
    let lastShown = -1;
    let firstGone: number | undefined;
    let lastMasked = -1;
    for (let n = around.from; n < around.to; n++) {
      const { sourceMs, masks } = frameAt(plan, n);
      if (sourceMs === null) continue;
      const field = fieldOn(n);
      const covered = masks.some(
        (mask) =>
          mask.x <= field.x0 &&
          mask.y <= field.y0 &&
          mask.x + mask.width >= field.x1 &&
          mask.y + mask.height >= field.y1,
      );
      if (covered) lastMasked = n;
      if (showsField(sourceMs)) {
        expect(firstGone, `frame ${n}: the field is back`).toBeUndefined();
        expect(covered, `frame ${n}: the field shows unmasked`).toBe(true);
        lastShown = n;
      } else if (lastShown !== -1) {
        firstGone ??= n;
      }
    }
    expect(
      showsField(frameAt(plan, around.from).sourceMs ?? Number.NaN),
      'the field is on screen when the click starts',
    ).toBe(true);
    if (firstGone === undefined) {
      throw new Error('the field never left the screen');
    }
    expect(((lastMasked - firstGone) * 1000) / fps).toBeLessThanOrEqual(300);

    // The mask really hides the field: a frame every 500 ms (15 at 30 fps)
    // while it is on screen, and the last one.
    const from = toFrame(password.startMs);
    const numbers = sampleFrames(from, lastShown + 1, fps / 2);
    expect(numbers.length).toBeGreaterThan(2);

    const masked = await extractFrames(maskedFile, numbers, plan);
    const unmasked = await extractFrames(unmaskedFile, numbers, plan);
    numbers.forEach((n, i) => {
      const { x0, y0, x1, y1 } = fieldOn(n);
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

  it('holds the page before a document load until the next one is ready, never a blank page', async () => {
    // A second `navigate` loads a new document (spec 114). Its scripts answer
    // 800 ms late, so it commits and shows its blank page well before `load`.
    const slowScripts: EngineObserver = {
      async onPageCreated({ page }) {
        await page.route('**/*.js', async (route) => {
          if (route.request().headers().referer?.endsWith('/long')) {
            await setTimeout(800);
          }
          await route.continue();
        });
      },
    };
    const runDir = await recordInlineRun(
      'two-pages',
      {
        schemaVersion: 1,
        name: 'Two pages',
        viewport: { width: 1280, height: 720 },
        steps: [
          { action: 'navigate', path: '/customers' },
          { action: 'wait', ms: 600 },
          { action: 'navigate', path: '/long' },
          { action: 'wait', ms: 800 },
        ],
      },
      parent,
      [slowScripts],
    );
    const timeline = TimelineSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'timeline.json'), 'utf8')),
    );
    expect(timeline.navigations).toHaveLength(2);
    const plan = await buildRenderPlan(runDir, {
      transitions: { enabled: true, durationMs: 300 },
    });
    const hold = plan.transitions?.holds[1];
    if (hold?.sourceMs === undefined) throw new Error('no held frame');
    const { fps } = plan.output;
    const frameOf = (ms: number): number => Math.ceil((ms * fps) / 1000 - 1e-6);
    const before = frameOf(hold.startMs) - 1;
    const held: number[] = [];
    for (let n = frameOf(hold.startMs); n < frameOf(hold.endMs); n++) {
      held.push(n);
      expect(frameAt(plan, n).sourceMs, `frame ${n}`).toBe(hold.sourceMs);
    }
    // The scripts' 800 ms: frames enough to see the blank page without the hold.
    expect(held.length).toBeGreaterThan(15);
    const middle = frameOf((hold.endMs + hold.fadeEndMs) / 2);
    expect(frameAt(plan, middle).fade?.from.sourceMs).toBe(hold.sourceMs);
    console.info(
      `page load: held ${hold.startMs.toFixed(0)}–${hold.endMs.toFixed(0)} ms, ${held.length} frames`,
    );

    await ffmpegRenderer.render(runDir, plan);
    const [last, ...rest] = await extractFrames(
      renderPath(runDir, 'ffmpeg'),
      [before, ...held, middle],
      plan,
    );
    const mid = rest.pop();
    // The share of pixels that clearly changed: a page's text and panels on a
    // light page are a small part of the frame, so a mean hides them.
    const changed = (a: Uint8Array, b: Uint8Array): number => {
      let count = 0;
      for (let at = 0; at < a.length; at += 3) {
        if (
          Math.abs(a[at] - b[at]) > 40 ||
          Math.abs(a[at + 1] - b[at + 1]) > 40 ||
          Math.abs(a[at + 2] - b[at + 2]) > 40
        ) {
          count++;
        }
      }
      return count / (a.length / 3);
    };
    // Every frame of the load is the page before it, as the last live frame
    // showed it — not the blank page of the new document.
    for (const [i, frame] of rest.entries()) {
      const share = changed(frame, last);
      console.info(`page load: frame ${held[i]} vs the page before, ${share}`);
      expect(share, `frame ${held[i]}`).toBeLessThan(0.001);
    }
    // Mid-dissolve: neither the held page nor the loaded one alone.
    if (mid === undefined) throw new Error('no mid-dissolve frame');
    console.info(`page load: mid-dissolve, ${changed(mid, last)}`);
    expect(changed(mid, last)).toBeGreaterThan(0.001);

    // Without the hold the same stretch shows the new document's blank page:
    // the check above would have caught it.
    const { transitions: _, ...cut } = plan;
    const cutFile = path.join(runDir, 'render', 'cut.mp4');
    await drawPlan(path.join(runDir, plan.source.file), cut, [cutFile]);
    const lastHeld = held.at(-1) ?? before;
    const [cutBefore, cutLate] = await extractFrames(
      cutFile,
      [before, lastHeld],
      cut,
    );
    const blank = changed(cutLate, cutBefore);
    console.info(`page load: frame ${lastHeld} without the hold, ${blank}`);
    expect(blank).toBeGreaterThan(0.01);
  });
});
