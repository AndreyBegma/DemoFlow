import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Response } from 'express';
import { Clock } from '../common/clock';
import type { RunFormat } from '../projects/projects.dto';
import {
  RunnerConnections,
  type VideoSink,
} from '../runner/runner-connections.service';
import type {
  VideoAsset,
  VideoChunk,
  VideoMessage,
  VideoRange,
} from '../runner/runner-socket';
import { spanOf } from './byte-range';

/** No `video.head` this long after `video.open`: 504 (spec #191, Decision 5). */
export const HEAD_TIMEOUT_MS = 10 * 1000;
/** No chunk this long mid-stream: the response is destroyed. */
export const CHUNK_TIMEOUT_MS = 30 * 1000;
/** How often the timeouts are checked. */
const SWEEP_INTERVAL_MS = 1000;

export const VIDEO_CONTENT_TYPES: Record<RunFormat, string> = {
  mp4: 'video/mp4',
  'mp4-vertical': 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
  'gif-vertical': 'image/gif',
  'webm-vertical': 'video/webm',
  'mp4-square': 'video/mp4',
  'gif-square': 'image/gif',
  'webm-square': 'video/webm',
};

const COMMON_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'private, no-store',
};

/** Runner errors before the head, as HTTP (Decision 4). `bad-range` is a 416. */
const RUNNER_ERRORS: Record<string, { status: number; error: string }> = {
  'not-found': { status: 404, error: 'video-missing' },
  busy: { status: 503, error: 'runner-busy' },
  io: { status: 502, error: 'runner-error' },
};
const UNKNOWN_RUNNER_ERROR = { status: 502, error: 'runner-error' };

interface Head {
  size: number;
  start: number;
  end: number;
}

/**
 * Where one stream's bytes go: a playback response, or a share's file (spec
 * #347, Decision 4). The relay owns the protocol — spans, timeouts, credit —
 * and a sink only takes what passed it.
 */
interface StreamSink {
  /** Logged with the stream's outcome. */
  readonly kind: 'play' | 'download' | 'upload';
  /** The head passed the span check. An error code refuses it. */
  head(head: Head, expected: number): string | null;
  /** In order. `taken` once the sink holds the bytes: they are acknowledged then. */
  write(bytes: Buffer, taken: () => void): void;
  /** Every byte the head announced came. */
  end(): void;
  /** Failed: `status` and `headers` count only for a response not yet started. */
  fail(status: number, error: string, headers?: Record<string, string>): void;
}

/** The HTTP response of `GET /runs/:id/video/:format` (spec #191). */
class ResponseSink implements StreamSink {
  readonly kind: 'play' | 'download';
  /** Chunks the response has not taken yet, acknowledged on `drain`. */
  private unacked: Array<() => void> = [];

  constructor(
    private readonly res: Response,
    private readonly format: RunFormat,
    private readonly range: VideoRange | null,
    /** Set for `?download=1`: the head says `attachment` (spec #299). */
    private readonly download: { fileName: string } | undefined,
  ) {
    this.kind = download ? 'download' : 'play';
  }

  head(head: Head, expected: number): null {
    const partial = this.range !== null;
    this.res.writeHead(partial ? 206 : 200, {
      ...COMMON_HEADERS,
      'Content-Type': VIDEO_CONTENT_TYPES[this.format],
      'Content-Length': String(expected),
      'Content-Disposition': this.download
        ? `attachment; filename="${this.download.fileName}"`
        : 'inline',
      ...(partial
        ? { 'Content-Range': `bytes ${head.start}-${head.end}/${head.size}` }
        : {}),
    });
    return null;
  }

  write(bytes: Buffer, taken: () => void): void {
    const took = this.res.write(bytes);
    if (took && this.unacked.length === 0) {
      taken();
      return;
    }
    this.unacked.push(taken);
    if (this.unacked.length === 1) {
      this.res.once('drain', () => {
        for (const ack of this.unacked.splice(0)) {
          ack();
        }
      });
    }
  }

  end(): void {
    this.res.end();
  }

  /** `{ error }` before the head; after it, the status is sent: destroy. */
  fail(
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ): void {
    if (this.res.headersSent) {
      this.res.destroy();
      return;
    }
    this.res
      .status(status)
      .set({ ...COMMON_HEADERS, ...headers })
      .json({ error });
  }
}

/** What an upload into a file settles with: the file's size, or an error code. */
export type UploadOutcome =
  | { ok: true; size: number }
  | { ok: false; error: string };

export interface UploadVideo {
  runnerId: string;
  runId: string;
  format: RunFormat;
  /** The share's poster instead of the render. */
  asset?: VideoAsset;
  /** Where the file lands. Bytes go to `<path>.part` until the last one came. */
  path: string;
  /** Checks the head's size before a byte is written; an error code refuses it. */
  accept: (size: number) => string | null;
}

/**
 * A share's file (spec #347, Decision 2): written to `<path>.part`, renamed
 * once every announced byte is on disk, deleted on anything else.
 */
class FileSink implements StreamSink {
  readonly kind = 'upload';
  private file: WriteStream | undefined;
  private failed = false;

  constructor(
    private readonly path: string,
    private readonly accept: (size: number) => string | null,
    /** The disk failed under the stream: the relay cancels it. */
    private readonly broken: () => void,
    private readonly settle: (outcome: UploadOutcome) => void,
  ) {}

  private get part(): string {
    return `${this.path}.part`;
  }

  head({ size }: Head): string | null {
    const refused = this.accept(size);
    if (refused !== null) {
      return refused;
    }
    this.file = createWriteStream(this.part);
    this.file.once('error', () => this.broken());
    return null;
  }

  write(bytes: Buffer, taken: () => void): void {
    this.file?.write(bytes, (error) => {
      if (!error) {
        taken();
      }
    });
  }

  end(): void {
    const file = this.file;
    if (!file) {
      return;
    }
    // `close`, not `finish`: the descriptor is released before the rename.
    file.once('close', () => {
      if (this.failed) {
        return;
      }
      rename(this.part, this.path).then(
        () => this.settle({ ok: true, size: file.bytesWritten }),
        () => this.discard('io'),
      );
    });
    file.end();
  }

  fail(_status: number, error: string): void {
    this.failed = true;
    this.file?.destroy();
    this.discard(error);
  }

  private discard(error: string): void {
    rm(this.part, { force: true }).then(
      () => this.settle({ ok: false, error }),
      () => this.settle({ ok: false, error }),
    );
  }
}

interface Stream {
  id: string;
  runnerId: string;
  runId: string;
  format: RunFormat;
  range: VideoRange | null;
  sink: StreamSink;
  /** Clock ms. */
  openedAt: number;
  lastChunkAt: number;
  /** `end - start + 1` of the head; null until it came. */
  expected: number | null;
  relayed: number;
}

export interface OpenVideo {
  runnerId: string;
  runId: string;
  format: RunFormat;
  range: VideoRange | null;
  download?: { fileName: string };
  res: Response;
}

/**
 * Plays a run's video from the machine that recorded it (spec #191, ADR-0009
 * §1): asks the Runner over its socket for the bytes and relays them into the
 * HTTP response, acknowledging each chunk once the response has taken it.
 * A share's upload (spec #347) pulls the same way into a file instead.
 *
 * Works only on the instance that holds the Runner's socket. Staging runs one
 * API instance; more would need sticky routing or a broker (Decision 10).
 */
@Injectable()
export class VideoRelay
  implements VideoSink, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoRelay.name);
  private readonly streams = new Map<string, Stream>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: RunnerConnections,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setVideoSink(this);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Streams open to the machine right now, uploads included. */
  openTo(runnerId: string): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (stream.runnerId === runnerId) {
        count += 1;
      }
    }
    return count;
  }

  /** Sends `video.open`; the response is answered from here on. */
  open({ runnerId, runId, format, range, download, res }: OpenVideo): void {
    const stream = this.start(
      runnerId,
      runId,
      format,
      range,
      new ResponseSink(res, format, range, download),
    );
    // Seeked or left: the Runner stops reading (Decision 6).
    res.on('close', () => {
      if (this.streams.get(stream.id) === stream) {
        this.cancel(stream);
        this.finish(stream, 'aborted');
      }
    });
    this.send(stream, undefined);
  }

  /**
   * Pulls the whole file into `path` (spec #347, Decision 4), with the
   * playback's timeouts and credit. Settles once the file is in place or gone.
   */
  upload({
    runnerId,
    runId,
    format,
    asset,
    path,
    accept,
  }: UploadVideo): Promise<UploadOutcome> {
    return new Promise((settle) => {
      let stream: Stream | undefined;
      const sink = new FileSink(
        path,
        accept,
        () => {
          if (stream && this.streams.get(stream.id) === stream) {
            this.cancel(stream);
            this.fail(stream, 500, 'io');
          }
        },
        settle,
      );
      stream = this.start(runnerId, runId, format, null, sink);
      this.send(stream, asset);
    });
  }

  message(runnerId: string, message: VideoMessage): void {
    const stream = this.streamOf(runnerId, message.streamId);
    if (!stream) {
      return;
    }
    switch (message.type) {
      case 'video.head':
        this.head(stream, message);
        return;
      case 'video.end':
        this.end(stream);
        return;
      case 'video.error':
        this.runnerError(stream, message.code, message.size);
        return;
    }
  }

  chunk(runnerId: string, { streamId, bytes }: VideoChunk): boolean {
    const stream = this.streamOf(runnerId, streamId);
    if (!stream) {
      return false;
    }
    if (stream.expected === null) {
      this.cancel(stream);
      this.fail(stream, 502, 'runner-error');
      return true;
    }
    // Bytes beyond the head's span must never pass as the file (Decision 7).
    if (stream.relayed + bytes.length > stream.expected) {
      this.cancel(stream);
      this.fail(stream, 502, 'overrun');
      return true;
    }
    stream.relayed += bytes.length;
    stream.lastChunkAt = this.clock.now().getTime();
    stream.sink.write(bytes, () => {
      if (this.streams.get(stream.id) === stream) {
        this.ack(stream, bytes.length);
      }
    });
    return true;
  }

  /** Every stream on the machine's socket ends with it (Decision 6). */
  closed(runnerId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.runnerId === runnerId) {
        this.fail(stream, 503, 'runner-offline');
      }
    }
  }

  /** The timeouts, on the injected clock. Runs every `SWEEP_INTERVAL_MS`. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const stream of [...this.streams.values()]) {
      if (stream.expected === null) {
        if (now - stream.openedAt >= HEAD_TIMEOUT_MS) {
          this.cancel(stream);
          this.fail(stream, 504, 'runner-timeout');
        }
      } else if (now - stream.lastChunkAt >= CHUNK_TIMEOUT_MS) {
        this.cancel(stream);
        this.fail(stream, 504, 'stalled');
      }
    }
  }

  private start(
    runnerId: string,
    runId: string,
    format: RunFormat,
    range: VideoRange | null,
    sink: StreamSink,
  ): Stream {
    const now = this.clock.now().getTime();
    const stream: Stream = {
      id: randomUUID(),
      runnerId,
      runId,
      format,
      range,
      sink,
      openedAt: now,
      lastChunkAt: now,
      expected: null,
      relayed: 0,
    };
    this.streams.set(stream.id, stream);
    return stream;
  }

  /** `asset` only for an upload: a daemon without `share` never sees the field. */
  private send(stream: Stream, asset: VideoAsset | undefined): void {
    const sent = this.connections.sendTo(stream.runnerId, {
      type: 'video.open',
      streamId: stream.id,
      runId: stream.runId,
      format: stream.format,
      range: stream.range,
      ...(asset ? { asset } : {}),
    });
    if (!sent) {
      this.fail(stream, 503, 'runner-offline');
    }
  }

  private head(stream: Stream, head: Head): void {
    // A second head, or one that is not the span asked for, is a broken daemon.
    const span = spanOf(stream.range, head.size);
    if (
      stream.expected !== null ||
      span === null ||
      span.start !== head.start ||
      span.end !== head.end
    ) {
      this.cancel(stream);
      this.fail(stream, 502, 'runner-error');
      return;
    }
    const expected = head.end - head.start + 1;
    const refused = stream.sink.head(head, expected);
    if (refused !== null) {
      this.cancel(stream);
      this.fail(stream, 502, refused);
      return;
    }
    stream.expected = expected;
    stream.lastChunkAt = this.clock.now().getTime();
  }

  private end(stream: Stream): void {
    if (stream.expected === null) {
      this.fail(stream, 502, 'runner-error');
      return;
    }
    if (stream.relayed !== stream.expected) {
      this.fail(stream, 502, 'short');
      return;
    }
    this.finish(stream, 'complete');
    stream.sink.end();
  }

  private runnerError(
    stream: Stream,
    code: string,
    size: number | undefined,
  ): void {
    if (stream.expected !== null) {
      this.fail(stream, 502, `runner ${code}`.slice(0, 80));
      return;
    }
    if (code === 'bad-range' && size !== undefined) {
      this.fail(stream, 416, 'bad-range', {
        'Content-Range': `bytes */${size}`,
      });
      return;
    }
    const { status, error } = RUNNER_ERRORS[code] ?? UNKNOWN_RUNNER_ERROR;
    this.fail(stream, status, error);
  }

  private ack(stream: Stream, bytes: number): void {
    this.connections.sendTo(stream.runnerId, {
      type: 'video.ack',
      streamId: stream.id,
      bytes,
    });
  }

  private cancel(stream: Stream): void {
    this.connections.sendTo(stream.runnerId, {
      type: 'video.cancel',
      streamId: stream.id,
    });
  }

  /**
   * Ends the stream with `error`. A short or broken body must never pass as a
   * complete one (Decision 7): a started response is destroyed, a file deleted.
   */
  private fail(
    stream: Stream,
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ): void {
    this.finish(stream, error);
    stream.sink.fail(status, error, headers);
  }

  private finish(stream: Stream, outcome: string): void {
    this.streams.delete(stream.id);
    // Decision 11: no email, no path.
    this.logger.log(
      JSON.stringify({
        event: 'video.stream',
        runId: stream.runId,
        format: stream.format,
        download: stream.sink.kind === 'download',
        upload: stream.sink.kind === 'upload',
        bytes: stream.relayed,
        outcome,
        durationMs: this.clock.now().getTime() - stream.openedAt,
      }),
    );
  }

  /** Only the machine a stream was opened on can speak for it. */
  private streamOf(runnerId: string, streamId: string): Stream | undefined {
    const stream = this.streams.get(streamId);
    return stream?.runnerId === runnerId ? stream : undefined;
  }
}
