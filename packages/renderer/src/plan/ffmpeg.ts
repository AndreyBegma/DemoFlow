import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Interval, VideoProbe } from './types.ts';

let resolved: string | undefined;

/**
 * The FFmpeg binary both renderers use (spec 4, Decisions): a system FFmpeg
 * on `PATH` wins, otherwise the pinned `ffmpeg-static` build. A system build
 * without libx264 (Fedora's `ffmpeg-free`) cannot write the H.264 output, so
 * it does not count.
 */
export function resolveFfmpeg(): string {
  if (resolved !== undefined) return resolved;
  const system = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (system.status === 0 && /\slibx264\s/.test(system.stdout)) {
    resolved = 'ffmpeg';
    return resolved;
  }
  // `ffmpeg-static` is CommonJS and exports the binary path, or null on an unsupported platform.
  const bundled = createRequire(import.meta.url)('ffmpeg-static') as
    | string
    | null;
  if (bundled === null || !existsSync(bundled)) {
    throw new Error(
      'no FFmpeg: none on PATH, and ffmpeg-static has no binary (was its install script blocked?)',
    );
  }
  resolved = bundled;
  return resolved;
}

export interface FfmpegOutput {
  stdout: string;
  stderr: string;
}

/** Runs FFmpeg with an argument array — never a shell string — and rejects on a non-zero exit. */
export async function runFfmpeg(
  args: readonly string[],
): Promise<FfmpegOutput> {
  const { stdout, stderr } = await runFfmpegRaw(args);
  return { stdout: stdout.toString('utf8'), stderr };
}

/** `runFfmpeg`, with stdout kept as bytes: raw video frames. */
export function runFfmpegRaw(
  args: readonly string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveFfmpeg(),
      ['-hide_banner', '-nostdin', ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } else {
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`ffmpeg exited with ${code}: ${tail}`));
      }
    });
  });
}

export interface FreezeOptions {
  /** The shortest frozen stretch reported. */
  minMs: number;
  /** A frame is unchanged when no luma sample moved by more than this (0–255). Default 24. */
  maxDiff?: number;
}

export interface ProbeOptions {
  /** Also find the frozen stretches. */
  freezes?: FreezeOptions;
}

/**
 * Codec noise between identical Playwright frames peaks at 11 luma levels;
 * the fixture's 12 px spinner never moves fewer than 36 (measured, spec 4).
 */
export const FREEZE_MAX_DIFF = 24;

/**
 * Per frame, the largest luma change from the previous frame. FFmpeg's
 * `freezedetect` averages over the whole frame, which a small spinner
 * cannot move past codec noise: at -60 dB it cut the fixture's spinner.
 */
const FRAME_DIFF =
  'tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX';

/**
 * One FFmpeg pass over the first video stream: size, frame rate, duration
 * and, when asked, the frozen stretches. Uses `ffmpeg` alone, because
 * `ffmpeg-static` ships no `ffprobe`.
 */
export async function probeVideo(
  file: string,
  options: ProbeOptions = {},
): Promise<VideoProbe> {
  const filter =
    options.freezes === undefined ? ['-c', 'copy'] : ['-vf', FRAME_DIFF];
  const { stdout, stderr } = await runFfmpeg([
    '-i',
    file,
    '-map',
    '0:v:0',
    ...filter,
    '-f',
    'null',
    '-progress',
    'pipe:1',
    '-nostats',
    '-',
  ]);
  return parseProbe(stdout, stderr, options.freezes);
}

/** Exported for tests: reads `probeVideo`'s FFmpeg output. */
export function parseProbe(
  progress: string,
  log: string,
  freezeOptions?: FreezeOptions,
): VideoProbe {
  const stream = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]+)/.exec(log);
  if (stream === null) throw new Error('ffmpeg reported no video stream');
  const details = stream[1];
  const codec = /^(\w+)/.exec(details)?.[1] ?? 'unknown';
  const size = /, (\d{2,5})x(\d{2,5})/.exec(details);
  if (size === null) throw new Error(`no frame size in "${details}"`);
  const rate = /([\d.]+) (?:fps|tbr)/.exec(details);
  if (rate === null) throw new Error(`no frame rate in "${details}"`);
  const fps = Number(rate[1]);
  // `vp9 (Profile 0), yuv420p(tv, progressive), …`: the format follows the codec's notes.
  const pixelFormat = /^\w+(?: \([^)]*\))*, (\w+)/.exec(details)?.[1];

  const durationMs = readDuration(progress, log, fps);
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    fps,
    durationMs,
    codec,
    ...(pixelFormat === undefined ? {} : { pixelFormat }),
    freezes:
      freezeOptions === undefined
        ? []
        : readFreezes(log, fps, durationMs, freezeOptions),
  };
}

/**
 * Runs of unchanged frames. The difference stamped at frame `i` compares it
 * with frame `i − 1`, so a run of quiet differences from `a` to `b` means
 * frames `a − 1` to `b` are the same picture, on screen until `b` ends.
 */
function readFreezes(
  log: string,
  fps: number,
  durationMs: number,
  options: FreezeOptions,
): Interval[] {
  const maxDiff = options.maxDiff ?? FREEZE_MAX_DIFF;
  const frameMs = 1000 / fps;
  const freezes: Interval[] = [];
  let run: Interval | undefined;
  const close = (): void => {
    if (run !== undefined && run.endMs - run.startMs >= options.minMs) {
      freezes.push(run);
    }
    run = undefined;
  };
  for (const match of log.matchAll(
    /pts_time:([\d.]+)\s*\n[^\n]*lavfi\.signalstats\.YMAX=(\d+)/g,
  )) {
    const atMs = Number(match[1]) * 1000;
    if (Number(match[2]) > maxDiff) {
      close();
    } else if (run === undefined) {
      run = {
        startMs: Math.max(0, atMs - frameMs),
        endMs: Math.min(durationMs, atMs + frameMs),
      };
    } else {
      run.endMs = Math.min(durationMs, atMs + frameMs);
    }
  }
  close();
  return freezes;
}

function readDuration(progress: string, log: string, fps: number): number {
  const header = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  if (header !== null) {
    const [, h, m, s] = header;
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  }
  // No duration in the container: count the frames that were read.
  const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
  if (frames === undefined) throw new Error('ffmpeg reported no duration');
  return (Number(frames) / fps) * 1000;
}
