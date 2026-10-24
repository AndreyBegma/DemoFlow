import { type ChildProcess, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { ENCODERS, missingEncoders, resolveFfmpeg } from '../plan/ffmpeg.ts';
import { frameAt, frameCount, type Layout } from '../plan/frame.ts';
import type {
  OutputFile,
  OutputSpec,
  RenderPlan,
  SourceSpec,
} from '../plan/types.ts';
import { type Compositor, createCompositor, renderStage } from './compose.ts';
import { drawLayers, sourcesOf } from './layers.ts';
import { createPicture, type Picture } from './raster.ts';

/**
 * Writes every frame of `plan` to `out`, one path per `plan.output.files`
 * entry: one FFmpeg decodes `sourceFile` into raw frames, each output frame
 * is drawn from `frameAt(plan, frame)` alone, and a second FFmpeg encodes
 * them into every file. The vertical MP4 (spec 176) is drawn from the same
 * source frames at its own size, `frameAt(plan, frame, 'vertical')`, into an
 * FFmpeg of its own.
 */
export async function drawPlan(
  sourceFile: string,
  plan: RenderPlan,
  out: readonly string[],
): Promise<void> {
  const { output } = plan;
  if (output.files.length === 0 || output.files.length !== out.length) {
    throw new Error(`expected one path per output, got ${out.length}`);
  }
  const binary = encoderBinary(output);
  const kept = keptFrames(plan);
  const source = openSource(sourceFile, plan.source, kept);
  const lanes: Lane[] = [];
  try {
    for (const layout of ['landscape', 'vertical', 'square'] as const) {
      const lane = openLane(binary, plan, out, layout);
      if (lane !== undefined) lanes.push(lane);
    }
    const frames = frameCount(plan);
    for (let frame = 0; frame < frames; frame++) {
      const slot = frame % 2;
      const drawn = new Map<number, Picture>();
      for (const lane of lanes) {
        await lane.pending[slot];
        const state = frameAt(plan, frame, lane.layout);
        // Both layouts show the same source times: only the first fetches.
        for (const sourceMs of sourcesOf(state)) {
          if (drawn.has(sourceMs)) continue;
          drawn.set(
            sourceMs,
            await source.at(sourceFrameIndex(sourceMs, plan.source)),
          );
        }
        drawLayers(
          lane.compositor,
          lane.pictures[slot],
          state,
          (sourceMs) => {
            const picture = drawn.get(sourceMs);
            if (picture === undefined) {
              throw new Error(`source ${sourceMs} ms was not fetched`);
            }
            return picture;
          },
          lane.scratch,
        );
        lane.pending[slot] = write(
          lane.encoder.input,
          lane.pictures[slot].data,
        );
      }
      for (const [index, lastFrame] of kept) {
        if (lastFrame <= frame) source.forget(index);
      }
    }
    for (const lane of lanes) {
      await Promise.all(lane.pending);
      lane.encoder.input.end();
    }
    await Promise.all(lanes.map((lane) => lane.encoder.done));
  } catch (error) {
    // A broken pipe means an encoder died: its own error says why. It is the
    // first to settle — the others still wait on their input.
    const reason = isPipeError(error)
      ? await Promise.race(
          lanes.map((lane) =>
            lane.encoder.done.then(
              () => undefined,
              (failure: unknown) => failure,
            ),
          ),
        )
      : undefined;
    await settle(lanes);
    throw reason ?? error;
  } finally {
    await source.close();
  }
}

/** Stops every lane's encoder and waits for it to exit. */
async function settle(lanes: readonly Lane[]): Promise<void> {
  for (const lane of lanes) {
    lane.encoder.input.destroy();
    await release(lane.encoder.process, lane.encoder.done);
  }
}

/** The frames of one layout, from drawing to their encoder. */
interface Lane {
  layout: Layout;
  compositor: Compositor;
  encoder: Encoder;
  /** Two pictures: one is drawn while FFmpeg still reads the other. */
  pictures: Picture[];
  pending: (Promise<void> | undefined)[];
  scratch: Picture[];
}

/**
 * The lane of `layout`: the landscape one writes every file that is neither
 * vertical nor square, at the output's size; the vertical and square ones
 * only theirs, each at its own. `undefined` when the plan has no file of that
 * layout.
 */
function openLane(
  binary: string,
  plan: RenderPlan,
  out: readonly string[],
  layout: Layout,
): Lane | undefined {
  const { output } = plan;
  const chosen = output.files.flatMap((file, i) =>
    layoutOf(file) === layout ? [{ file, path: out[i] }] : [],
  );
  if (chosen.length === 0) return undefined;
  const crop = layout === 'vertical' ? plan.vertical : plan.square;
  const size = layout === 'landscape' || crop === undefined ? output : crop;
  const spec: OutputSpec = {
    width: size.width,
    height: size.height,
    fps: output.fps,
    files: chosen.map(({ file }) => file),
  };
  const compositor =
    layout === 'landscape'
      ? createCompositor(spec, renderStage(plan))
      : createCompositor(spec, undefined, crop?.caption);
  return {
    layout,
    compositor,
    encoder: startEncoder(
      binary,
      spec,
      chosen.map(({ path }) => path),
    ),
    pictures: [0, 1].map(() => createPicture(spec.width, spec.height)),
    pending: [undefined, undefined],
    scratch: [],
  };
}

/** The picture a file is encoded from: its format's suffix names the crop. */
function layoutOf(file: OutputFile): Layout {
  if (file.format.endsWith('-vertical')) return 'vertical';
  if (file.format.endsWith('-square')) return 'square';
  return 'landscape';
}

/** The source frame on screen at `sourceMs`. */
export function sourceFrameIndex(sourceMs: number, source: SourceSpec): number {
  // A hair of slack, so 40 ms at 25 fps is frame 1 despite floating point.
  return Math.max(0, Math.floor((sourceMs * source.fps) / 1000 + 1e-6));
}

/**
 * The source frames the page-load holds draw after the decoder has passed
 * them (spec 114), each with the last output frame that draws it.
 */
function keptFrames(plan: RenderPlan): Map<number, number> {
  const kept = new Map<number, number>();
  for (const hold of plan.transitions?.holds ?? []) {
    if (hold.sourceMs === undefined) continue;
    const index = sourceFrameIndex(hold.sourceMs, plan.source);
    // A card dissolving across the hold's edge may draw it a card's length later.
    const lastMs =
      hold.fadeEndMs +
      Math.max(0, ...plan.cards.map((card) => card.durationMs));
    const lastFrame = Math.ceil((lastMs * plan.output.fps) / 1000);
    kept.set(index, Math.max(kept.get(index) ?? 0, lastFrame));
  }
  return kept;
}

interface Source {
  /**
   * Frame `index`, or the last one when the video is shorter. Indexes never
   * go back, except to a kept frame: an earlier one gives the current frame.
   */
  at(index: number): Promise<Picture>;
  /** Releases a kept frame once nothing draws it any more. */
  forget(index: number): void;
  /** Stops the decoder and resolves once it has exited. */
  close(): Promise<void>;
}

/**
 * Decodes `file` to RGB24 frames at the source's constant frame rate, read
 * forward once. The frames `kept` names stay in memory as it passes them.
 */
function openSource(
  file: string,
  spec: SourceSpec,
  kept: ReadonlyMap<number, number> = new Map(),
): Source {
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
  const keeping = new Map<number, Picture>();

  return {
    async at(wanted) {
      const past = wanted < index ? keeping.get(wanted) : undefined;
      if (past !== undefined) return past;
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
          // Each frame is a fresh buffer, so a kept one is never overwritten.
          if (kept.has(index)) keeping.set(index, current);
        }
      }
      if (current === undefined) throw new Error('the source has no frames');
      return current;
    },
    forget(dropped) {
      keeping.delete(dropped);
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

/**
 * The FFmpeg that can write every file of `output`: a format whose encoder it
 * lacks fails here, before anything starts, naming the format (spec 133).
 */
function encoderBinary(output: OutputSpec): string {
  const required = output.files.map((file) => ENCODERS[file.format]);
  const binary = resolveFfmpeg(required);
  const missing = missingEncoders(binary, required);
  for (const file of output.files) {
    if (missing.includes(ENCODERS[file.format])) {
      throw new Error(
        `cannot encode the ${file.format}: ${binary} has no ${ENCODERS[file.format]} encoder`,
      );
    }
  }
  return binary;
}

/**
 * One FFmpeg reading RGB24 frames of `output`'s size on stdin and writing
 * every file of `output`, `out[i]` for `files[i]`.
 */
function startEncoder(
  binary: string,
  output: OutputSpec,
  out: readonly string[],
): Encoder {
  const child = spawn(binary, encoderArgs(output, out), {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  if (child.stdin === null) throw new Error('the encoder has no stdin');
  // A write after FFmpeg died fails with EPIPE; `done` carries the reason.
  child.stdin.on('error', () => undefined);
  const formats = output.files.map((file) => file.format).join(', ');
  const done = exited(child, `encoding the ${formats}`);
  done.catch(() => undefined);
  return { process: child, input: child.stdin, done };
}

/**
 * Exported for tests: the encoder's arguments. The raw frames are split once
 * per file in one filter graph, so every file comes from the same frames in
 * one pass (spec 133, Decision 2).
 */
export function encoderArgs(
  output: OutputSpec,
  out: readonly string[],
): string[] {
  const { files } = output;
  if (files.length === 0 || files.length !== out.length) {
    throw new Error(`expected one path per output, got ${out.length}`);
  }
  const graph =
    files.length === 1
      ? [`[0:v]${branch(files[0], 0)}`]
      : [
          `[0:v]split=${files.length}${files.map((_, i) => `[s${i}]`).join('')}`,
          ...files.map((file, i) => `[s${i}]${branch(file, i)}`),
        ];
  return [
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
    '-filter_complex',
    graph.join(';'),
    ...files.flatMap((file, i) => [
      '-map',
      `[v${i}]`,
      ...fileArgs(file),
      out[i],
    ]),
  ];
}

/** The filters from the raw frames to file `i`'s, labelled `[v<i>]`. */
function branch(file: OutputFile, i: number): string {
  switch (file.format) {
    case 'mp4':
    case 'mp4-vertical':
    case 'mp4-square':
    case 'webm':
    case 'webm-vertical':
    case 'webm-square':
      // BT.709, limited range, tagged in the stream: FFmpeg's
      // default RGB → YUV conversion is BT.601 and leaves the file untagged.
      return `scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=${file.pixelFormat}[v${i}]`;
    case 'gif':
    case 'gif-vertical':
    case 'gif-square':
      // A palette per frame (spec 133, Decision 3). One palette for the
      // whole video comes only at the end, and until then FFmpeg queues the
      // full-size frames of this branch: 13 GB for a 60 s render beside
      // MP4 and WebM, against 1.5 GB this way.
      return [
        `fps=${file.fps},scale=${file.width}:${file.height}:flags=lanczos,split[g${i}][h${i}]`,
        `[g${i}]palettegen=stats_mode=single[p${i}]`,
        `[h${i}][p${i}]paletteuse=new=1:dither=bayer:bayer_scale=5:diff_mode=rectangle[v${i}]`,
      ].join(';');
  }
}

const BT709_TAGS = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];

/** The encoder options of one file, before its path. */
function fileArgs(file: OutputFile): string[] {
  switch (file.format) {
    case 'mp4':
    case 'mp4-vertical':
    case 'mp4-square':
      return [
        ...BT709_TAGS,
        '-c:v',
        ENCODERS[file.format],
        '-preset',
        'medium',
        '-crf',
        '18',
        '-pix_fmt',
        file.pixelFormat,
        ...(file.faststart ? ['-movflags', '+faststart'] : []),
      ];
    case 'webm':
    case 'webm-vertical':
    case 'webm-square':
      return [
        ...BT709_TAGS,
        '-c:v',
        ENCODERS[file.format],
        '-crf',
        String(file.crf),
        '-b:v',
        '0',
        '-deadline',
        'good',
        '-cpu-used',
        String(file.cpuUsed),
        '-row-mt',
        '1',
        '-pix_fmt',
        file.pixelFormat,
      ];
    case 'gif':
    case 'gif-vertical':
    case 'gif-square':
      return ['-c:v', ENCODERS.gif, '-loop', '0'];
  }
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
