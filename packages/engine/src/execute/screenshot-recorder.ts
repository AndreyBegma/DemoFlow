import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserContext, CDPSession, Frame, Page } from 'playwright';
import type { RecordingOptions } from './recording.ts';

/**
 * Spike #85, `DEMOFLOW_CAPTURE=screenshots`: the source pulled as screenshots
 * at device pixels over CDP, several requests in flight, then encoded to a
 * 25 fps VP8 WebM like Playwright's own recording.
 */

/** Requests in flight; `DEMOFLOW_CAPTURE_INFLIGHT` overrides it. */
export const DEFAULT_IN_FLIGHT = 3;

/** The source frame rate, Playwright's `recordVideo` rate. */
export const SOURCE_FPS = 25;

const FIRST_FRAME_TIMEOUT_MS = 10_000;

/** A screenshot slower than this is given up and its session reopened. */
const GRAB_TIMEOUT_MS = 1_000;

/** The recorder's log, written next to the video as `screenshot-capture.json`. */
export interface ScreenshotLog {
  inFlight: number;
  /** Every answered request, in video ms (the first frame is 0), in answer order. */
  replies: number[];
  /** The distinct frames kept, in video ms and capture order. */
  frames: Array<{ atMs: number; hash: string }>;
  /** Requests that failed (a navigation in progress, for one). */
  errors: number;
  /** Video ms at which capture stopped: the last frame lasts until then. */
  endMs: number;
}

export interface ScreenshotRecorder {
  /** Stops capturing; resolves once every request in flight has answered. */
  stop(): Promise<void>;
  /** Encodes the frames to `file`, removes them, writes the log; returns `file`. */
  encode(file: string): Promise<string>;
}

export interface ScreenshotRecorderOptions {
  /** An FFmpeg with `libvpx`; the caller supplies it (`DEMOFLOW_FFMPEG`). */
  ffmpeg: string;
  inFlight: number;
  /** Where frames wait for the encode; removed after it. */
  framesDir: string;
}

/**
 * Starts pulling frames and resolves on the first one, so the engine clock
 * starts after the video does, as with `recordVideo`.
 */
export async function startScreenshotRecorder(
  context: BrowserContext,
  page: Page,
  recording: RecordingOptions,
  options: ScreenshotRecorderOptions,
): Promise<ScreenshotRecorder> {
  await mkdir(options.framesDir, { recursive: true });
  // A navigation that swaps the renderer (about:blank to the app, for one)
  // leaves a CDP session behind: its screenshots then never answer. A failed
  // or late request opens a new session, once for all workers.
  let cdp = await context.newCDPSession(page);
  let reopening: Promise<void> | undefined;
  const reopen = (stale: CDPSession): Promise<void> => {
    if (cdp !== stale || stopping) return reopening ?? Promise.resolve();
    reopening ??= (async () => {
      await stale.detach().catch(() => {});
      cdp = await context.newCDPSession(page);
    })()
      .catch(() => {})
      .finally(() => {
        reopening = undefined;
      });
    return reopening;
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) void reopen(cdp);
  };
  page.on('framenavigated', onNavigated);
  // A screenshot answers in the calling session's device metrics, and this
  // session has none: without a clip it is CSS-sized. The device-scale clip
  // gets device pixels, but Chromium then clears the page's emulation —
  // Playwright's — so the page falls to devicePixelRatio 1. Setting metrics
  // on this session instead keeps the page at 2 and breaks Playwright's
  // clicks. Measured in #85; the report has the numbers.
  const clip = {
    x: 0,
    y: 0,
    width: recording.viewport.width,
    height: recording.viewport.height,
    scale: recording.deviceScaleFactor,
  };

  let origin: number | undefined;
  let stopping = false;
  let endAt = 0;
  const replies: number[] = [];
  const frames: Array<{ at: number; hash: string }> = [];
  const written = new Set<string>();
  let errors = 0;
  let firstFrame: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    firstFrame = resolve;
  });

  const worker = async (): Promise<void> => {
    while (!stopping) {
      const sent = performance.now();
      const session = cdp;
      const data = await grab(session, clip);
      if (data === undefined) {
        errors++;
        await reopen(session);
        continue;
      }
      // The frame's time is the request's midpoint; half the round-trip is its error.
      const at = (sent + performance.now()) / 2;
      origin ??= at;
      replies.push(at);
      const hash = createHash('sha1').update(data).digest('hex');
      if (frames.at(-1)?.hash !== hash) {
        frames.push({ at, hash });
        if (!written.has(hash)) {
          written.add(hash);
          await writeFile(
            path.join(options.framesDir, `${hash}.jpg`),
            Buffer.from(data, 'base64'),
          );
        }
      }
      firstFrame();
    }
  };
  const workers = Array.from({ length: options.inFlight }, worker);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), FIRST_FRAME_TIMEOUT_MS);
  });
  const started = await Promise.race([first, timeout]);
  clearTimeout(timer);
  if (started === 'timeout') {
    stopping = true;
    page.off('framenavigated', onNavigated);
    await Promise.all(workers);
    throw new Error(`no screenshot within ${FIRST_FRAME_TIMEOUT_MS} ms`);
  }

  return {
    async stop() {
      if (!stopping) endAt = performance.now();
      stopping = true;
      page.off('framenavigated', onNavigated);
      await Promise.all(workers);
      await cdp.detach().catch(() => {});
    },

    async encode(file) {
      const zero = origin ?? endAt;
      const ordered = frames
        .map((frame) => ({ atMs: frame.at - zero, hash: frame.hash }))
        .sort((a, b) => a.atMs - b.atMs);
      const log: ScreenshotLog = {
        inFlight: options.inFlight,
        replies: replies.map((at) => at - zero),
        frames: ordered,
        errors,
        endMs: endAt - zero,
      };
      const list = path.join(options.framesDir, 'frames.ffconcat');
      await writeFile(list, concatList(ordered, log.endMs));
      await encodeWebm(options.ffmpeg, list, file);
      await writeFile(
        path.join(path.dirname(file), 'screenshot-capture.json'),
        `${JSON.stringify(log)}\n`,
      );
      await rm(options.framesDir, { recursive: true, force: true });
      return file;
    },
  };
}

/** A screenshot, or `undefined` when it failed or took longer than `GRAB_TIMEOUT_MS`. */
async function grab(
  cdp: CDPSession,
  clip: { x: number; y: number; width: number; height: number; scale: number },
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), GRAB_TIMEOUT_MS);
  });
  const shot = cdp
    .send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 90,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
      clip,
    })
    .then(
      (reply) => reply.data,
      () => undefined,
    );
  try {
    return await Promise.race([shot, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An FFmpeg concat script holding each distinct frame until the next one; the
 * last holds until capture stopped. Frames are named by hash, relative to the
 * script, so no path quoting is needed on any OS.
 */
export function concatList(
  frames: ReadonlyArray<{ atMs: number; hash: string }>,
  endMs: number,
): string {
  const lines = ['ffconcat version 1.0'];
  // The first frame starts the video, whatever its own time.
  const times = frames.map((frame, i) => (i === 0 ? 0 : frame.atMs));
  for (const [i, frame] of frames.entries()) {
    const until = times[i + 1] ?? Math.max(endMs, (times[i] ?? 0) + 1);
    lines.push(`file '${frame.hash}.jpg'`);
    lines.push(`duration ${((until - (times[i] ?? 0)) / 1000).toFixed(6)}`);
  }
  // The concat demuxer drops the last entry's duration unless it is repeated.
  const last = frames.at(-1);
  if (last !== undefined) lines.push(`file '${last.hash}.jpg'`);
  return `${lines.join('\n')}\n`;
}

/** Playwright's own VP8 settings for `recordVideo`, at 25 fps constant rate. */
function encodeWebm(ffmpeg: string, list: string, file: string): Promise<void> {
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `fps=${SOURCE_FPS},format=yuv420p`,
    '-c:v',
    'libvpx',
    '-qmin',
    '0',
    '-qmax',
    '50',
    '-crf',
    '8',
    '-deadline',
    'realtime',
    '-speed',
    '8',
    '-b:v',
    '1M',
    '-an',
    file,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}
