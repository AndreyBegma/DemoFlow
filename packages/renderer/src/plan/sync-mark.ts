import type { Timeline } from '@demoflow/core';
import { runFfmpegRaw } from './ffmpeg.ts';

export type SyncMark = NonNullable<Timeline['syncMark']>;

/** One colour, 0–255 per channel. */
export type Rgb = readonly [number, number, number];

/** A frame is read as a grid of this many cells a side, each the mean of its area. */
export const SYNC_GRID = 4;

/**
 * A cell matches the mark when no channel is further than this from it. VP8
 * decodes `#ff00ff` as (253, 0, 252); the cleared blank page is 253 levels
 * off in green and the fixture app ~245 (measured, #19).
 */
export const SYNC_TOLERANCE = 64;

/** A measured offset further from zero than this is not believed (Decision 5). */
export const MAX_SYNC_OFFSET_MS = 500;

/** How much video past `offMs` is searched for the clear: the video leads the clock. */
const SEARCH_PAST_OFF_MS = 1_000;

/** `#rrggbb` → its channels. */
export function parseColour(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * The index of the first frame without the mark after frames with it, or
 * `undefined` when no frame shows it or it never clears. A frame shows the
 * mark only when every cell matches, so a page with some of the colour does not.
 */
export function syncClearFrame(
  frames: readonly (readonly Rgb[])[],
  colour: Rgb,
): number | undefined {
  const marked = frames.map(
    (cells) =>
      cells.length > 0 &&
      cells.every((cell) =>
        cell.every(
          (channel, index) =>
            Math.abs(channel - colour[index]) <= SYNC_TOLERANCE,
        ),
      ),
  );
  const first = marked.indexOf(true);
  if (first === -1) return undefined;
  const clear = marked.findIndex(
    (isMarked, index) => index > first && !isMarked,
  );
  return clear === -1 ? undefined : clear;
}

/**
 * The source time of the first frame after the sync mark (Decision 4), or
 * `undefined` when it is not found. Frame `i` is the picture at `i / fps`, as
 * the compositor reads the source. Never throws: no mark means the defaults.
 *
 * Only the top-left quarter of the frame is read. Playwright's 2× recording
 * shows the page in that quarter alone (#47), and on any source it is page:
 * the mark covers the whole viewport.
 */
export async function findSyncClear(
  file: string,
  fps: number,
  mark: SyncMark,
): Promise<number | undefined> {
  try {
    const { stdout } = await runFfmpegRaw([
      '-loglevel',
      'error',
      '-t',
      String((mark.offMs + SEARCH_PAST_OFF_MS) / 1000),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `fps=${fps},crop=iw/2:ih/2:0:0,scale=${SYNC_GRID}:${SYNC_GRID}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ]);
    const frameBytes = SYNC_GRID * SYNC_GRID * 3;
    const frames: Rgb[][] = [];
    for (let at = 0; at + frameBytes <= stdout.length; at += frameBytes) {
      const cells: Rgb[] = [];
      for (let cell = at; cell < at + frameBytes; cell += 3) {
        cells.push([stdout[cell], stdout[cell + 1], stdout[cell + 2]]);
      }
      frames.push(cells);
    }
    const clear = syncClearFrame(frames, parseColour(mark.colour));
    return clear === undefined ? undefined : (clear * 1000) / fps;
  } catch {
    return undefined;
  }
}

/**
 * `sourceMs = timelineMs + offsetMs`, measured on the clear (Decision 4), or
 * `undefined` when it is implausible.
 *
 * `offMs` is read after the clear is presented, ~10 ms after the page
 * cleared (#19), and the clear frame is up to a frame after the clear. The
 * offset is therefore at most a frame later than the truth, which the
 * one-frame mask lead absorbs, and never corrected toward later.
 */
export function syncOffset(
  mark: SyncMark,
  clearMs: number | undefined,
): number | undefined {
  if (clearMs === undefined) return undefined;
  const offsetMs = clearMs - mark.offMs;
  return Math.abs(offsetMs) <= MAX_SYNC_OFFSET_MS ? offsetMs : undefined;
}
