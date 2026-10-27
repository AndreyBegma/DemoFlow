import { open, readFile, realpath } from 'node:fs/promises';
import {
  RENDER_FORMATS,
  type RenderFormat,
  RunResultSchema,
} from '@demoflow/core';
import { pathFor } from '../../config/platform.ts';
import { findReportedRun } from '../../runs-report/reported-runs.ts';
import type { Logger } from '../log.ts';
import { posterPath } from '../share/files.ts';
import { parseRange } from './range.ts';
import {
  type RelayFile,
  type RelaySender,
  type StreamOutcome,
  VideoStream,
} from './stream.ts';

export type { RelayFile, RelaySender } from './stream.ts';

/** Decision 7: a fifth concurrent `video.open` is `busy`. */
export const MAX_STREAMS = 4;

/** `RUN_FILES.result` of the engine, which the daemon does not load. */
const RESULT_FILE = 'result.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A server id: short, and safe to write into `runner.log` as it is. */
export const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The filesystem the relay reads; tests count `open` and `close`. */
export interface RelayFs {
  realpath(file: string): Promise<string>;
  readFile(file: string): Promise<string>;
  open(file: string): Promise<RelayFile>;
}

export const nodeRelayFs: RelayFs = {
  realpath: (file) => realpath(file),
  readFile: (file) => readFile(file, 'utf8'),
  open: (file) => open(file, 'r'),
};

export interface RelayDeps {
  /** `reported-runs.jsonl`. */
  indexFile: string;
  fs: RelayFs;
  logger: Logger;
  platform: NodeJS.Platform;
}

/** What the connection needs from the relay. */
export interface VideoRelayPort {
  handle(message: Record<string, unknown>, sender: RelaySender): void;
  /** The socket closed: every stream ends and releases its file. */
  closeAll(): void;
  /**
   * Spec 234, Decision 4: every stream of one server run ends with
   * `video.error { code: 'io' }`; resolves once their files are released.
   */
  closeRun(runId: string): Promise<void>;
}

/**
 * Decision 4, the ADR-0008 boundary: is `target` inside `root`, both already
 * real paths? Windows paths compare without case.
 */
export function isInside(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const p = pathFor(platform);
  const fold = (value: string) =>
    platform === 'win32' ? value.toLowerCase() : value;
  const relative = p.relative(fold(root), fold(target));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${p.sep}`) &&
    !p.isAbsolute(relative)
  );
}

/**
 * Spec 349, Decision 4: what `video.open` may ask for besides the render.
 * Anything else is `not-found`.
 */
export const VIDEO_ASSETS = ['poster'] as const;
export type VideoAsset = (typeof VIDEO_ASSETS)[number];

/**
 * The real path of a reported run's rendered file in `format` — or, with
 * `asset: 'poster'`, of the poster a share made for it — or `null`. The run
 * directory comes from the index, never from the message, and only a file
 * `result.json` lists, or the poster's fixed name, inside that directory,
 * can come out.
 */
export async function locateVideo(
  runId: string,
  format: RenderFormat,
  deps: RelayDeps,
  asset?: VideoAsset,
): Promise<string | null> {
  const entry = await findReportedRun(deps.indexFile, runId);
  if (entry === null) return null;
  const p = pathFor(deps.platform);
  try {
    if (asset === 'poster') {
      const root = await deps.fs.realpath(entry.runDir);
      const real = await deps.fs.realpath(
        posterPath(entry.runDir, format, deps.platform),
      );
      return isInside(root, real, deps.platform) ? real : null;
    }
    const parsed = RunResultSchema.safeParse(
      JSON.parse(await deps.fs.readFile(p.join(entry.runDir, RESULT_FILE))),
    );
    if (!parsed.success) return null;
    const render = parsed.data.renders.find((item) => item.format === format);
    if (render === undefined) return null;
    const root = await deps.fs.realpath(entry.runDir);
    const real = await deps.fs.realpath(p.resolve(entry.runDir, render.file));
    return isInside(root, real, deps.platform) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The daemon's side of the video relay (spec 192): `video.open`, `video.ack`
 * and `video.cancel` in; `video.head`, chunks, `video.end` and `video.error`
 * out. No path is ever sent or logged.
 */
export class VideoRelay implements VideoRelayPort {
  private readonly deps: RelayDeps;
  private readonly streams = new Map<string, VideoStream>();
  /** The server run id of each open stream, for `closeRun`. */
  private readonly runIds = new Map<string, string>();

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  /** The number of open streams. */
  get size(): number {
    return this.streams.size;
  }

  handle(message: Record<string, unknown>, sender: RelaySender): void {
    switch (message.type) {
      case 'video.open':
        this.open(message, sender);
        return;
      case 'video.ack': {
        const { streamId, bytes } = message;
        if (
          typeof streamId !== 'string' ||
          !Number.isSafeInteger(bytes) ||
          (bytes as number) < 0
        ) {
          this.deps.logger.log('warn', 'ignored a malformed video.ack');
          return;
        }
        // Acks keep arriving after `video.end`: an unknown id is normal.
        this.streams.get(streamId)?.ack(bytes as number);
        return;
      }
      case 'video.cancel': {
        const { streamId } = message;
        if (typeof streamId !== 'string') {
          this.deps.logger.log('warn', 'ignored a malformed video.cancel');
          return;
        }
        void this.streams.get(streamId)?.close('cancelled');
        return;
      }
      default:
        this.deps.logger.log(
          'warn',
          `ignored a message of type ${JSON.stringify(message.type)?.slice(0, 64)}`,
        );
    }
  }

  closeAll(): void {
    for (const stream of [...this.streams.values()]) {
      void stream.close('disconnected');
    }
  }

  async closeRun(runId: string): Promise<void> {
    const closing: Array<Promise<void>> = [];
    for (const [streamId, stream] of [...this.streams]) {
      if (this.runIds.get(streamId) === runId) {
        closing.push(stream.fail('io').then(() => stream.released()));
      }
    }
    await Promise.all(closing);
  }

  private open(message: Record<string, unknown>, sender: RelaySender): void {
    const { streamId, runId, format } = message;
    const range = parseRange(message.range);
    if (
      typeof streamId !== 'string' ||
      !UUID.test(streamId) ||
      typeof runId !== 'string' ||
      !RUN_ID.test(runId) ||
      !RENDER_FORMATS.includes(format as RenderFormat) ||
      range === undefined
    ) {
      this.deps.logger.log('warn', 'ignored a malformed video.open');
      return;
    }
    const videoFormat = format as RenderFormat;
    const { asset } = message;
    // An asset this daemon does not know opens, and fails `not-found`.
    const known =
      asset === undefined || VIDEO_ASSETS.includes(asset as VideoAsset);
    const videoAsset = asset === undefined ? undefined : (asset as VideoAsset);
    if (this.streams.has(streamId)) {
      this.deps.logger.log(
        'warn',
        `ignored a video.open for stream ${streamId}, which is already open`,
      );
      return;
    }
    const what = known && videoAsset !== undefined ? ` ${videoAsset}` : '';
    if (this.streams.size >= MAX_STREAMS) {
      sender.send({ type: 'video.error', streamId, code: 'busy' });
      this.logStream(runId, videoFormat, what, 0, 'busy');
      return;
    }
    const stream = new VideoStream(streamId, sender, (outcome, sent) => {
      if (this.streams.get(streamId) === stream) {
        this.streams.delete(streamId);
        this.runIds.delete(streamId);
      }
      this.logStream(runId, videoFormat, what, sent, outcome);
    });
    this.streams.set(streamId, stream);
    this.runIds.set(streamId, runId);
    void stream.begin(async () => {
      if (!known) return null;
      const file = await locateVideo(runId, videoFormat, this.deps, videoAsset);
      return file === null ? null : this.deps.fs.open(file);
    }, range);
  }

  /** Decision 9: one line per stream, with no path in it. */
  private logStream(
    runId: string,
    format: RenderFormat,
    asset: string,
    sent: number,
    outcome: StreamOutcome | 'busy',
  ): void {
    this.deps.logger.log(
      'info',
      `video ${runId} ${format}${asset}: ${sent} bytes sent, ${outcome}`,
    );
  }
}
