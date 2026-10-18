import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Browser, type CDPSession, chromium, type Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { DEVICE_SCALE_FACTOR } from '../../src/index.ts';

/**
 * Spike #82, opt-in: what frame size a CDP screencast delivers when the page
 * is emulated at `deviceScaleFactor: 2`, next to what a screenshot delivers,
 * and how fast each produces frames. Evidence for the report, run per OS by
 * the execution-plane workflow's `cdp-spike` job; skipped everywhere else.
 */
const ENABLED = process.env.DEMOFLOW_CDP_SPIKE === '1';

const VIEWPORT = { width: 1280, height: 720 } as const;
const SAMPLE_MS = 3000;

/** Text and a block moved every animation frame: the page changes every frame. */
const PAGE = `<!doctype html><title>spike</title>
<body style="margin:0;background:#fff;font:16px sans-serif">
<h1 style="margin:40px">Customers — device pixel probe</h1>
<div id="block" style="width:120px;height:120px;background:#c00"></div>
<script>
  let i = 0;
  const step = () => {
    document.getElementById('block').style.marginLeft = ((i++ * 4) % 1000) + 'px';
    requestAnimationFrame(step);
  };
  step();
</script>
</body>`;

interface Size {
  width: number;
  height: number;
}

interface ModeReport {
  mode: string;
  screencastFrame: Size;
  screencastMetadata: Record<string, unknown>;
  screencastFps: number;
  screencastMaxGapMs: number;
  screenshot: Size;
  screenshotFps: number;
  screenshotMaxGapMs: number;
  devicePixelRatio: number;
}

/** A JPEG's size from its first start-of-frame marker. */
function jpegSize(jpeg: Buffer): Size {
  let at = 2;
  while (at + 9 < jpeg.length) {
    const marker = jpeg[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        width: jpeg.readUInt16BE(at + 7),
        height: jpeg.readUInt16BE(at + 5),
      };
    }
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error('no start-of-frame marker in the JPEG');
}

function rate(
  times: readonly number[],
  spanMs: number,
): { fps: number; maxGapMs: number } {
  let maxGapMs = 0;
  for (let i = 1; i < times.length; i++) {
    maxGapMs = Math.max(maxGapMs, (times[i] ?? 0) - (times[i - 1] ?? 0));
  }
  return { fps: (times.length * 1000) / spanMs, maxGapMs };
}

async function screencast(
  cdp: CDPSession,
  params: Record<string, unknown>,
): Promise<{
  frame: Size;
  metadata: Record<string, unknown>;
  fps: number;
  maxGapMs: number;
}> {
  const times: number[] = [];
  let first: { data: string; metadata: Record<string, unknown> } | undefined;
  // The protocol types are not exported by `playwright`: only what is read here.
  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }): void => {
    times.push(Number(event.metadata.timestamp) * 1000);
    first ??= { data: event.data, metadata: { ...event.metadata } };
    void cdp
      .send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', params);
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  if (first === undefined) throw new Error('the screencast sent no frame');
  return {
    frame: jpegSize(Buffer.from(first.data, 'base64')),
    metadata: first.metadata,
    ...rate(times, SAMPLE_MS),
  };
}

/**
 * Playwright's screenshot, not a bare `Page.captureScreenshot`: the bare call
 * returns CSS pixels too (1280×720, measured); Playwright asks for the clip at
 * the device scale factor.
 */
async function screenshots(
  page: Page,
): Promise<{ frame: Size; fps: number; maxGapMs: number }> {
  const times: number[] = [];
  let frame: Size | undefined;
  const start = performance.now();
  while (performance.now() - start < SAMPLE_MS) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 90 });
    times.push(performance.now());
    frame ??= jpegSize(shot);
  }
  if (frame === undefined) throw new Error('no screenshot');
  return { frame, ...rate(times, SAMPLE_MS) };
}

async function probe(mode: string, browser: Browser): Promise<ModeReport> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  try {
    const page = await context.newPage();
    await page.setContent(PAGE);
    const cdp = await context.newCDPSession(page);
    const cast = await screencast(cdp, {
      format: 'jpeg',
      quality: 90,
      maxWidth: VIEWPORT.width * DEVICE_SCALE_FACTOR,
      maxHeight: VIEWPORT.height * DEVICE_SCALE_FACTOR,
    });
    const shots = await screenshots(page);
    return {
      mode,
      screencastFrame: cast.frame,
      screencastMetadata: cast.metadata,
      screencastFps: cast.fps,
      screencastMaxGapMs: cast.maxGapMs,
      screenshot: shots.frame,
      screenshotFps: shots.fps,
      screenshotMaxGapMs: shots.maxGapMs,
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
    };
  } finally {
    await context.close();
  }
}

const reports: ModeReport[] = [];

afterAll(async () => {
  if (!ENABLED) return;
  const summary = {
    platform: `${os.platform()}-${os.arch()}`,
    cpus: os.cpus().length,
    chromium: chromium.executablePath(),
    reports,
  };
  console.info(`CDP_SPIKE ${JSON.stringify(summary)}`);
  const out = process.env.DEMOFLOW_CDP_SPIKE_OUT;
  if (out !== undefined && out !== '') {
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, `screencast-size-${os.platform()}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
});

describe.runIf(ENABLED)('CDP screencast at deviceScaleFactor 2 (#82)', () => {
  // Launch options per mode: the default headless shell, and new headless.
  const modes: ReadonlyArray<[string, Parameters<typeof chromium.launch>[0]]> =
    [
      ['headless-shell', {}],
      ['new-headless', { channel: 'chromium' }],
    ];

  for (const [mode, launch] of modes) {
    it(`reports frame sizes and rates (${mode})`, async () => {
      const browser = await chromium.launch(launch);
      try {
        const report = await probe(mode, browser);
        reports.push(report);
        // Evidence, not a verdict: the page is at 2×; the frame sizes are what the report records.
        expect(report.devicePixelRatio).toBe(DEVICE_SCALE_FACTOR);
        expect(report.screenshot).toEqual({
          width: VIEWPORT.width * DEVICE_SCALE_FACTOR,
          height: VIEWPORT.height * DEVICE_SCALE_FACTOR,
        });
      } finally {
        await browser.close();
      }
    });
  }
});
