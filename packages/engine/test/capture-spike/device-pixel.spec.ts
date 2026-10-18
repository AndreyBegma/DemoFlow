import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { parseScenario, type Scenario, type Timeline } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScreenshotLog } from '../../src/execute/screenshot-recorder.ts';
import {
  type CaptureMode,
  captureMode,
  createCaptureObserver,
  type EngineObserver,
  runScenario,
} from '../../src/index.ts';
import {
  FIXTURE_DIST,
  type FixtureServer,
  startFixtureServer,
} from '../execute/fixture-server.ts';
import {
  cadence,
  edgeContrast,
  FRAME_MS,
  frameRgb,
  MIN_QUADRANT_RANGE,
  quadrantRanges,
  type Region,
  thumbnails,
  videoSize,
  zoomedSample,
} from './measure.ts';

/**
 * Spike #85, opt-in: every fixture scenario recorded at 1× and in the
 * `DEMOFLOW_CAPTURE` mode, measured against #82's Decision 1 — source size,
 * the #73 quadrant check, effective fps and the longest gap during steps,
 * sharpness at 1.6× zoom, run time — and, for `zoomed`, layout equivalence.
 * Evidence for `docs/research/85-device-pixel-capture-spike.md`, run per OS
 * by the execution-plane workflow's `cdp-spike` job; skipped everywhere else.
 */
const ENABLED = process.env.DEMOFLOW_CAPTURE_SPIKE === '1';
// Read only when enabled: the #82 probe's dispatch sets no capture mode.
const MODE: CaptureMode = ENABLED
  ? captureMode(process.env.DEMOFLOW_CAPTURE)
  : 'video';
const FFMPEG = process.env.DEMOFLOW_FFMPEG ?? '';

const SCENARIOS = ['customers', 'login', 'tour', 'failing'] as const;
type FixtureScenario = (typeof SCENARIOS)[number];
const SCENARIO_DIR = path.join(FIXTURE_DIST, '..', 'demoflow');
const PASSWORD = 'hunter2-correct-horse';

/**
 * The heading, search row and first rows of the customer list, in CSS
 * pixels, as step `SHARPNESS_STEP` of `customers` starts: the list is still
 * and no dialog is open yet.
 */
const TEXT_REGION: Region = { x: 264, y: 100, width: 740, height: 260 };
const SHARPNESS_STEP = 4;

/**
 * A block moved every animation frame in the bottom-left corner, outside
 * every measured region: the page always has a new frame, so a repeated video
 * frame is one the capture missed (#82's probe page, on the real fixture).
 */
function animate(): void {
  const start = (): void => {
    const block = document.createElement('div');
    block.style.cssText =
      'position:fixed;left:0;bottom:0;width:24px;height:24px;background:#c00;z-index:2147483647;pointer-events:none';
    document.documentElement.append(block);
    let i = 0;
    const step = (): void => {
      block.style.transform = `translateX(${(i++ * 4) % 400}px)`;
      requestAnimationFrame(step);
    };
    step();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

/** What the page's layout answers after a step, in its own (possibly zoomed) pixels. */
interface PageLayout {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  scrollWidth: number;
  scrollHeight: number;
  /** The width of a `100vw` element. */
  vw: number;
  /** Every `@media` condition in the page's stylesheets, and common breakpoints. */
  media: Record<string, boolean>;
}

function measureLayout(): PageLayout {
  const queries = new Set<string>();
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) queries.add(rule.media.mediaText);
      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin sheet cannot be read.
    }
  }
  for (const width of [640, 768, 1024, 1280, 1536]) {
    queries.add(`(min-width: ${width}px)`);
  }
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:0;top:0;width:100vw;height:1px;visibility:hidden';
  document.documentElement.append(probe);
  const vw = probe.getBoundingClientRect().width;
  probe.remove();
  const root = document.documentElement;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    vw,
    media: Object.fromEntries(
      [...queries].map((query) => [query, window.matchMedia(query).matches]),
    ),
  };
}

interface Recorded {
  capture: CaptureMode;
  runDir: string;
  wallMs: number;
  status: string;
  timeline: Timeline;
  layouts: PageLayout[];
}

interface RunReport {
  capture: CaptureMode;
  wallMs: number;
  stepsMs: number;
  status: string;
  source: { width: number; height: number };
  quadrantRanges: number[];
  quadrantsOk: boolean;
  /** Distinct frames per second and the longest repeat, from step 0's start to the last step's end. */
  cadence: { fps: number; maxGapMs: number };
  syncMark: boolean;
  devicePixelRatios: number[];
  screenshots?: {
    inFlight: number;
    errors: number;
    replyFps: number;
    maxReplyGapMs: number;
  };
}

interface ScenarioReport {
  scenario: FixtureScenario;
  baseline: RunReport;
  run: RunReport;
  sharpness?: { baseline: number; run: number; ratio: number };
  /** Every layout difference from the 1× run; empty when the layout matches. Not for `video`. */
  layoutDifferences?: string[];
}

const reports: ScenarioReport[] = [];
const runDirs: string[] = [];
let fixture: FixtureServer;

async function loadScenario(name: FixtureScenario): Promise<Scenario> {
  const raw = await readFile(
    path.join(SCENARIO_DIR, `${name}.demo.json`),
    'utf8',
  );
  const parsed = parseScenario(JSON.parse(raw));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

async function record(
  name: FixtureScenario,
  capture: CaptureMode,
): Promise<Recorded> {
  const runDir = path.join(
    await mkdtemp(path.join(tmpdir(), 'demoflow-85-')),
    name,
  );
  runDirs.push(path.dirname(runDir));
  let page: Page | undefined;
  const layouts: PageLayout[] = [];
  const probe: EngineObserver = {
    async onPageCreated(event) {
      page = event.page;
      await page.addInitScript(animate);
    },
    async onStepFinished() {
      const layout = await page?.evaluate(measureLayout).catch(() => undefined);
      if (layout !== undefined) layouts.push(layout);
    },
  };
  const started = performance.now();
  const outcome = await runScenario(await loadScenario(name), {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
    env: { FIXTURE_PASSWORD: PASSWORD },
    capture,
    observers: [
      probe,
      createCaptureObserver({ scenarioId: `demoflow/${name}.demo.json` }),
    ],
  });
  const wallMs = performance.now() - started;
  const timeline = JSON.parse(
    await readFile(path.join(runDir, 'timeline.json'), 'utf8'),
  ) as Timeline;
  return {
    capture,
    runDir,
    wallMs,
    status: outcome.status,
    timeline,
    layouts,
  };
}

async function measure(run: Recorded): Promise<RunReport> {
  const file = path.join(run.runDir, 'source.webm');
  const source = await videoSize(FFMPEG, file);
  const frames = await thumbnails(FFMPEG, file);
  const middle = await frameRgb(
    FFMPEG,
    file,
    Math.floor(frames.length / 2),
    source,
  );
  const ranges = quadrantRanges(middle, source);
  const events = run.timeline.events;
  const report: RunReport = {
    capture: run.capture,
    wallMs: Math.round(run.wallMs),
    stepsMs: Math.round(events.at(-1)?.endMs ?? 0),
    status: run.status,
    source,
    quadrantRanges: ranges,
    quadrantsOk: ranges.every((range) => range >= MIN_QUADRANT_RANGE),
    cadence: cadence(
      frames,
      events[0]?.startMs ?? 0,
      events.at(-1)?.endMs ?? frames.length * FRAME_MS,
    ),
    syncMark: run.timeline.syncMark !== undefined,
    devicePixelRatios: [
      ...new Set(run.layouts.map((layout) => layout.devicePixelRatio)),
    ],
  };
  if (run.capture === 'screenshots') {
    const log = JSON.parse(
      await readFile(path.join(run.runDir, 'screenshot-capture.json'), 'utf8'),
    ) as ScreenshotLog;
    const replies = [...log.replies].sort((a, b) => a - b);
    let maxReplyGapMs = 0;
    for (let i = 1; i < replies.length; i++) {
      maxReplyGapMs = Math.max(
        maxReplyGapMs,
        (replies[i] ?? 0) - (replies[i - 1] ?? 0),
      );
    }
    report.screenshots = {
      inFlight: log.inFlight,
      errors: log.errors,
      replyFps: (replies.length * 1000) / Math.max(1, log.endMs),
      maxReplyGapMs: Math.round(maxReplyGapMs),
    };
  }
  return report;
}

/** Edge contrast of the text region as step `SHARPNESS_STEP` starts; a sample PNG when the job keeps them. */
async function sharpness(run: Recorded, report: RunReport): Promise<number> {
  const file = path.join(run.runDir, 'source.webm');
  const startMs = run.timeline.events[SHARPNESS_STEP]?.startMs ?? 0;
  const index = Math.round(startMs / FRAME_MS);
  const scale = report.source.width / run.timeline.viewport.width;
  const out = process.env.DEMOFLOW_CDP_SPIKE_OUT;
  if (out !== undefined && out !== '') {
    await mkdir(out, { recursive: true });
    await zoomedSample(
      FFMPEG,
      file,
      index,
      TEXT_REGION,
      scale,
      path.join(out, `sample-${run.capture}-${os.platform()}.png`),
    );
  }
  return edgeContrast(FFMPEG, file, index, TEXT_REGION, scale);
}

/** Layout equivalence (spec 85): boxes, page size and media answers as at 1×, within 1 px. */
function layoutDifferences(
  baseline: Recorded,
  run: Recorded,
  zoom: number,
): string[] {
  const differences: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  for (const [i, expected] of baseline.timeline.events.entries()) {
    const actual = run.timeline.events[i];
    const a = expected.target?.box;
    const b = actual?.target?.box;
    if (a === undefined && b === undefined) continue;
    if (
      a === undefined ||
      b === undefined ||
      !near(a.x, b.x) ||
      !near(a.y, b.y) ||
      !near(a.width, b.width) ||
      !near(a.height, b.height)
    ) {
      differences.push(
        `step ${i}: target box ${JSON.stringify(a)} at 1×, ${JSON.stringify(b)} ${run.capture}`,
      );
    }
  }
  for (const [i, expected] of baseline.layouts.entries()) {
    const actual = run.layouts[i];
    if (actual === undefined) {
      differences.push(`step ${i}: no layout measured`);
      continue;
    }
    for (const key of [
      'innerWidth',
      'innerHeight',
      'scrollWidth',
      'scrollHeight',
      'vw',
    ] as const) {
      if (!near(expected[key], actual[key] / zoom)) {
        differences.push(
          `step ${i}: ${key} ${expected[key]} at 1×, ${actual[key] / zoom} ${run.capture} (÷${zoom})`,
        );
      }
    }
    for (const [query, matches] of Object.entries(expected.media)) {
      if (actual.media[query] !== matches) {
        differences.push(
          `step ${i}: matchMedia('${query}') ${matches} at 1×, ${actual.media[query]} ${run.capture}`,
        );
      }
    }
  }
  return differences;
}

beforeAll(async () => {
  if (!ENABLED) return;
  if (FFMPEG === '') throw new Error('the spike needs DEMOFLOW_FFMPEG');
  fixture = await startFixtureServer();
});

afterAll(async () => {
  if (!ENABLED) return;
  await fixture?.close();
  const summary = {
    mode: MODE,
    platform: `${os.platform()}-${os.arch()}`,
    cpus: os.cpus().length,
    inFlight: process.env.DEMOFLOW_CAPTURE_INFLIGHT,
    reports,
  };
  console.info(`DEVICE_PIXEL_SPIKE ${JSON.stringify(summary)}`);
  const out = process.env.DEMOFLOW_CDP_SPIKE_OUT;
  if (out !== undefined && out !== '') {
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, `device-pixel-${MODE}-${os.platform()}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.runIf(ENABLED)(`a 2× source, DEMOFLOW_CAPTURE=${MODE} (#85)`, () => {
  for (const scenario of SCENARIOS) {
    it(`records and measures ${scenario} at 1× and in the mode`, async () => {
      const baseline = await record(scenario, 'video');
      const run = MODE === 'video' ? baseline : await record(scenario, MODE);
      const report: ScenarioReport = {
        scenario,
        baseline: await measure(baseline),
        run: await measure(run),
      };
      if (scenario === 'customers') {
        const before = await sharpness(baseline, report.baseline);
        const after = await sharpness(run, report.run);
        report.sharpness = {
          baseline: before,
          run: after,
          ratio: after / before,
        };
      }
      // Zoomed: the spec's equivalence check. Screenshots: the page under
      // test must not notice the recorder either.
      if (MODE !== 'video') {
        report.layoutDifferences = layoutDifferences(
          baseline,
          run,
          MODE === 'zoomed' ? 2 : 1,
        );
      }
      reports.push(report);
      // Evidence only: the criteria are judged in the report, not here.
      expect(report.run.source.width).toBeGreaterThan(0);
    });
  }
});
