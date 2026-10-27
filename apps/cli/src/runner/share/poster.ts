import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { runFfmpeg } from '@demoflow/renderer';
import { pathFor } from '../../config/platform.ts';

/** #347: the API refuses a poster over 1 MiB, so the daemon does too. */
export const POSTER_MAX_BYTES = 1024 * 1024;
/** Decision 3: the frame is taken at most this far in. */
export const POSTER_AT_MAX_MS = 1500;
/** Decision 3: the poster is at most this wide, keeping the aspect. */
export const POSTER_MAX_WIDTH = 1280;

/** FFmpeg, as the poster maker runs it; tests stub it. */
export type RunFfmpeg = (args: readonly string[]) => Promise<unknown>;

export interface PosterRequest {
  /** The render's file, already checked to be inside the run directory. */
  render: string;
  /** Where the poster lives: `posterPath(runDir, format)`. */
  poster: string;
  /** The render's `durationMs`. */
  durationMs: number;
  platform: NodeJS.Platform;
}

/** The FFmpeg arguments for one JPEG frame of `render` at `atMs`. */
export function posterArgs(
  render: string,
  output: string,
  atMs: number,
): string[] {
  return [
    '-y',
    '-i',
    render,
    // After `-i`: a GIF cannot be seeked on input, and the decode is short.
    '-ss',
    (atMs / 1000).toFixed(3),
    '-frames:v',
    '1',
    '-an',
    '-vf',
    `scale='min(${POSTER_MAX_WIDTH},iw)':-2`,
    '-q:v',
    '4',
    output,
  ];
}

/** Decision 3: `min(1500, ⌊durationMs / 2⌋)`. */
export function posterAtMs(durationMs: number): number {
  return Math.min(POSTER_AT_MAX_MS, Math.floor(Math.max(0, durationMs) / 2));
}

/**
 * Decision 3: the poster of a render, made with FFmpeg unless the one on
 * disk is newer than the render, and its size in bytes. It is written to a
 * temporary file and renamed, so a crash never leaves half a JPEG to reuse.
 * Rejects when FFmpeg fails or the poster is over `POSTER_MAX_BYTES`.
 */
export async function makePoster(
  request: PosterRequest,
  ffmpeg: RunFfmpeg = runFfmpeg,
): Promise<number> {
  const { render, poster } = request;
  const rendered = await stat(render);
  const existing = await stat(poster).catch(() => null);
  let size: number;
  if (existing !== null && existing.mtimeMs > rendered.mtimeMs) {
    size = existing.size;
  } else {
    const p = pathFor(request.platform);
    await mkdir(p.dirname(poster), { recursive: true });
    const temp = `${poster.slice(0, -'.jpg'.length)}.tmp.jpg`;
    try {
      await ffmpeg(posterArgs(render, temp, posterAtMs(request.durationMs)));
      await rename(temp, poster);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    size = (await stat(poster)).size;
  }
  if (size === 0 || size > POSTER_MAX_BYTES) {
    throw new Error(`the poster is ${size} bytes`);
  }
  return size;
}
