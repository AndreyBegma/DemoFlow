import { type ChildProcess, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { resolveFfmpeg } from '../plan/ffmpeg.ts';
import { frameAt, frameCount } from '../plan/frame.ts';
import type { RenderPlan, SourceSpec } from '../plan/types.ts';
import { createCompositor, renderStage } from './compose.ts';
import { createPicture, type Picture } from './raster.ts';

/**
 * Writes every frame of `plan` to `out`, an MP4: one FFmpeg decodes
 * `sourceFile` into raw frames, each output frame is drawn from
 * `frameAt(plan, frame)` alone, and a second FFmpeg encodes them.
 */
export async function drawPlan(
  sourceFile: string,
  plan: RenderPlan,
  out: string,
): Promise<void> {
  const { output } = plan;
  const compositor = createCompositor(output, renderStage(plan));
  const source = openSource(sourceFile, plan.source);
  const encoder = startEncoder(plan, out);
  // Two pictures: one is drawn while FFmpeg still reads the other.
  const pictures = [0, 1].map(() => createPicture(output.width, output.height));
  const pending: (Promise<void> | undefined)[] = [undefined, undefined];
  try {
    const frames = frameCount(plan);
    for (let frame = 0; frame < frames; frame++) {
      const slot = frame % 2;
      await pending[slot];
      const state = frameAt(plan, frame);
      const picture =
        state.sourceMs === null
          ? undefined
          : await source.at(sourceFrameIndex(state.sourceMs, plan.source));
      compositor.compose(pictures[slot], state, picture);
      pending[slot] = write(encoder.input, pictures[slot].data);
    }
    await Promise.all(pending);
    encoder.input.end();
    await encoder.done;
  } catch (error) {
    // A broken pipe means the encoder died: its own error says why.
    if (isPipeError(error)) await encoder.done;
    encoder.input.destroy();
    await release(encoder.process, encoder.done);
    throw error;
  } finally {
    await source.close();
  }
}

/** The source frame on screen at `sourceMs`. */
export function sourceFrameIndex(sourceMs: number, source: SourceSpec): number {
  // A hair of slack, so 40 ms at 25 fps is frame 1 despite floating point.
  return Math.max(0, Math.floor((sourceMs * source.fps) / 1000 + 1e-6));
}

interface Source {
  /** Frame `index`, or the last one when the video is shorter. Indexes never go back. */
  at(index: number): Promise<Picture>;
  /** Stops the decoder and resolves once it has exited. */
  close(): Promise<void>;
}

/** Decodes `file` to RGB24 frames at the source's constant frame rate, read forward once. */
function openSource(file: string, spec: SourceSpec): Source {
  const child = spawn(
    resolveFfmpeg(),
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      // Constant rate: frame `i` is the picture at `i / fps`.
      '-vf',
      `fps=${spec.fps},scale=${spec.width}:${spec.height}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const failed = exited(child, 'decoding the source');
  failed.catch(() => undefined);
  const frames = readFrames(child, spec.width * spec.height * 3);
  let index = -1;
  let current: Picture | undefined;
  let ended = false;

  return {
    async at(wanted) {
      while (index < wanted && !ended) {
        const next = await frames.next();
        if (next.done) {
          ended = true;
          await failed;
        } else {
          current = {
            width: spec.width,
            height: spec.height,
            data: next.value,
          };
          index++;
        }
      }
      if (current === undefined) throw new Error('the source has no frames');
      return current;
    },
    close() {
      // The plan rarely needs the last source frame, so the decoder is
      // usually blocked writing one into a full pipe — and FFmpeg acts on
      // SIGTERM only once that write returns. Closing our end fails the
      // write (EPIPE), and the kill covers a decoder that is not writing.
      child.stdout?.destroy();
      return release(child, failed);
    },
  };
}

/** Kills `child` unless it has exited, and resolves once it has: Node holds an unexited child's handle and pipes. */
async function release(
  child: ChildProcess,
  exit: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exit.catch(() => undefined);
}

/** Whole frames of `size` bytes from the child's stdout. */
async function* readFrames(
  child: ChildProcess,
  size: number,
): AsyncGenerator<Uint8Array> {
  if (child.stdout === null) throw new Error('the decoder has no stdout');
  let frame = new Uint8Array(size);
  let filled = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(size - filled, chunk.length - offset);
      frame.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield frame;
        frame = new Uint8Array(size);
        filled = 0;
      }
    }
  }
}

interface Encoder {
  process: ChildProcess;
  input: Writable;
  /** Settles when FFmpeg exits: resolves on success. */
  done: Promise<void>;
}

/** FFmpeg reading RGB24 frames on stdin and writing `plan.output` to `out`. */
function startEncoder(plan: RenderPlan, out: string): Encoder {
  const { output } = plan;
  const child = spawn(
    resolveFfmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${output.width}x${output.height}`,
      '-r',
      String(output.fps),
      '-i',
      'pipe:0',
      // BT.709, limited range, tagged in the stream: FFmpeg's
      // default RGB → YUV conversion is BT.601 and leaves the file untagged.
      '-vf',
      `scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=${output.pixelFormat}`,
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      output.pixelFormat,
      ...(output.faststart ? ['-movflags', '+faststart'] : []),
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  if (child.stdin === null) throw new Error('the encoder has no stdin');
  // A write after FFmpeg died fails with EPIPE; `done` carries the reason.
  child.stdin.on('error', () => undefined);
  const done = exited(child, 'encoding the MP4');
  done.catch(() => undefined);
  return { process: child, input: child.stdin, done };
}

/** Resolves when `child` exits with 0; rejects with the tail of its stderr otherwise. */
function exited(child: ChildProcess, doing: string): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(
          new Error(
            `ffmpeg failed ${doing} (${signal ?? `exit ${code}`}): ${tail}`,
          ),
        );
      }
    });
  });
}

function isPipeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

function write(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });
}
