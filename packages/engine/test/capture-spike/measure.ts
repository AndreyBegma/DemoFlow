import { spawn } from 'node:child_process';

/**
 * Spike #85: what the harness measures on a recorded `source.webm`, through
 * the FFmpeg the job supplies (`DEMOFLOW_FFMPEG`). The renderer's own checks
 * live in its tests, which the engine cannot import.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The analysis size frames are hashed at: changes, not detail, are counted. */
const THUMB = { width: 320, height: 180 } as const;

/** Source frames are 25 fps, constant rate, in every mode. */
export const FRAME_MS = 40;

export async function ffmpeg(
  binary: string,
  args: readonly string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/** The video's frame size, from FFmpeg's stream line. */
export async function videoSize(binary: string, file: string): Promise<Size> {
  const { stderr } = await ffmpeg(binary, [
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  const match = /Video: [^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  if (match === null) throw new Error(`no video stream in ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Every frame, grey, at the thumbnail size. */
export async function thumbnails(
  binary: string,
  file: string,
): Promise<Buffer[]> {
  const { stdout } = await ffmpeg(binary, [
    '-i',
    file,
    '-vf',
    `scale=${THUMB.width}:${THUMB.height}:flags=area,format=gray`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-',
  ]);
  const size = THUMB.width * THUMB.height;
  const frames: Buffer[] = [];
  for (let at = 0; at + size <= stdout.length; at += size) {
    frames.push(stdout.subarray(at, at + size));
  }
  return frames;
}

/**
 * The animated block's strip (bottom 24 CSS px, left 424) on a thumbnail of a
 * 1280-wide viewport, and how many of its pixels must move by more than
 * `MOVED_LEVEL` for a new frame: VP8 never repeats a frame byte for byte.
 */
const STRIP = { x0: 0, x1: 110, y0: THUMB.height - 7, y1: THUMB.height };
const MOVED_LEVEL = 24;
const MOVED_PIXELS = 4;

function moved(a: Buffer, b: Buffer): boolean {
  let count = 0;
  for (let y = STRIP.y0; y < STRIP.y1; y++) {
    for (let x = STRIP.x0; x < STRIP.x1; x++) {
      const at = y * THUMB.width + x;
      if (Math.abs((a[at] ?? 0) - (b[at] ?? 0)) > MOVED_LEVEL) count++;
    }
  }
  return count >= MOVED_PIXELS;
}

/**
 * Effective frame rate and longest gap between `fromMs` and `toMs`: a frame
 * counts when the block the page animates every display frame has moved, so
 * a repeated frame is a frame the capture missed.
 */
export function cadence(
  frames: readonly Buffer[],
  fromMs: number,
  toMs: number,
): { fps: number; maxGapMs: number } {
  const first = Math.max(1, Math.floor(fromMs / FRAME_MS));
  const last = Math.min(frames.length - 1, Math.ceil(toMs / FRAME_MS));
  let changes = 0;
  let since = first - 1;
  let maxGap = 0;
  for (let i = first; i <= last; i++) {
    if (moved(frames[i] as Buffer, frames[i - 1] as Buffer)) {
      changes++;
      maxGap = Math.max(maxGap, i - since);
      since = i;
    }
  }
  maxGap = Math.max(maxGap, last + 1 - since);
  const spanMs = Math.max(FRAME_MS, (last - first + 1) * FRAME_MS);
  return { fps: (changes * 1000) / spanMs, maxGapMs: maxGap * FRAME_MS };
}

/** Frame `index`, RGB24 at the source size. */
export async function frameRgb(
  binary: string,
  file: string,
  index: number,
  size: Size,
): Promise<Buffer> {
  const { stdout } = await ffmpeg(binary, [
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
    '-',
  ]);
  if (stdout.length !== size.width * size.height * 3) {
    throw new Error(`frame ${index}: ${stdout.length} bytes`);
  }
  return stdout;
}

/** The #73 check, as the renderer's `checkLayout`: page content in every quadrant. */
export function quadrantRanges(frame: Buffer, size: Size): number[] {
  const midX = size.width >> 1;
  const midY = size.height >> 1;
  const range = (x0: number, y0: number, x1: number, y1: number): number => {
    let low = 255;
    let high = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const at = (y * size.width + x) * 3;
        const luma =
          0.2126 * (frame[at] ?? 0) +
          0.7152 * (frame[at + 1] ?? 0) +
          0.0722 * (frame[at + 2] ?? 0);
        low = Math.min(low, luma);
        high = Math.max(high, luma);
      }
    }
    return Math.round(high - low);
  };
  return [
    range(0, 0, midX, midY),
    range(midX, 0, size.width, midY),
    range(0, midY, midX, size.height),
    range(midX, midY, size.width, size.height),
  ];
}

/** A quadrant counts as page content when its luminance spans at least this much (#73). */
export const MIN_QUADRANT_RANGE = 24;

function zoomFilter(
  index: number,
  region: Region,
  sourceScale: number,
  zoom: number,
): { filter: string; width: number; height: number } {
  const width = Math.round(region.width * zoom);
  const height = Math.round(region.height * zoom);
  const crop = [region.width, region.height, region.x, region.y]
    .map((value) => Math.round(value * sourceScale))
    .join(':');
  return {
    filter: `select=eq(n\\,${index}),crop=${crop},scale=${width}:${height}:flags=lanczos`,
    width,
    height,
  };
}

/** `region` of frame `index` as the renderer's 1.6× zoom shows it, saved as a PNG for the report. */
export async function zoomedSample(
  binary: string,
  file: string,
  index: number,
  region: Region,
  sourceScale: number,
  png: string,
  zoom = 1.6,
): Promise<void> {
  const { filter } = zoomFilter(index, region, sourceScale, zoom);
  await ffmpeg(binary, [
    '-y',
    '-i',
    file,
    '-vf',
    filter,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    png,
  ]);
}

/**
 * Decision 1's edge-contrast metric: `region` (CSS pixels) of frame `index`,
 * scaled to 1.6× its CSS size as the renderer's zoom shows it, in grey; the
 * mean Sobel gradient magnitude. A sharper source has stronger edges there.
 */
export async function edgeContrast(
  binary: string,
  file: string,
  index: number,
  region: Region,
  sourceScale: number,
  zoom = 1.6,
): Promise<number> {
  const { filter, width, height } = zoomFilter(
    index,
    region,
    sourceScale,
    zoom,
  );
  const { stdout } = await ffmpeg(binary, [
    '-i',
    file,
    '-vf',
    `${filter},format=gray`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-',
  ]);
  if (stdout.length !== width * height) {
    throw new Error(`edge region: ${stdout.length} bytes`);
  }
  const at = (x: number, y: number): number => stdout[y * width + x] ?? 0;
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      total += Math.hypot(gx, gy);
    }
  }
  return total / ((width - 2) * (height - 2));
}
