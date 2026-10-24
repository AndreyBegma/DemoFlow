import { randomUUID } from 'node:crypto';
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

interface Stream {
  id: string;
  runnerId: string;
  runId: string;
  format: RunFormat;
  range: VideoRange | null;
  /** Set for `?download=1`: the head says `attachment` (spec #299). */
  download: { fileName: string } | undefined;
  res: Response;
  /** Clock ms. */
  openedAt: number;
  lastChunkAt: number;
  /** `end - start + 1` of the head; null until it came. */
  expected: number | null;
  relayed: number;
  /** Sizes of chunks the response has not taken yet, acknowledged on `drain`. */
  unacked: number[];
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
 * Nothing is stored here.
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

  /** Streams open to the machine right now. */
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
    const now = this.clock.now().getTime();
    const stream: Stream = {
      id: randomUUID(),
      runnerId,
      runId,
      format,
      range,
      download,
      res,
      openedAt: now,
      lastChunkAt: now,
      expected: null,
      relayed: 0,
      unacked: [],
    };
    this.streams.set(stream.id, stream);
    // Seeked or left: the Runner stops reading (Decision 6).
    res.on('close', () => {
      if (this.streams.get(stream.id) === stream) {
        this.cancel(stream);
        this.finish(stream, 'aborted');
      }
    });
    const sent = this.connections.sendTo(runnerId, {
      type: 'video.open',
      streamId: stream.id,
      runId,
      format,
      range,
    });
    if (!sent) {
      this.fail(stream, 503, 'runner-offline');
    }
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
      this.destroy(stream, 'overrun');
      return true;
    }
    stream.relayed += bytes.length;
    stream.lastChunkAt = this.clock.now().getTime();
    const taken = stream.res.write(bytes);
    if (taken && stream.unacked.length === 0) {
      this.ack(stream, bytes.length);
      return true;
    }
    stream.unacked.push(bytes.length);
    if (stream.unacked.length === 1) {
      stream.res.once('drain', () => this.drained(stream));
    }
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
        this.destroy(stream, 'stalled');
      }
    }
  }

  private head(
    stream: Stream,
    head: { size: number; start: number; end: number },
  ): void {
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
    stream.expected = head.end - head.start + 1;
    stream.lastChunkAt = this.clock.now().getTime();
    const partial = stream.range !== null;
    stream.res.writeHead(partial ? 206 : 200, {
      ...COMMON_HEADERS,
      'Content-Type': VIDEO_CONTENT_TYPES[stream.format],
      'Content-Length': String(stream.expected),
      'Content-Disposition': stream.download
        ? `attachment; filename="${stream.download.fileName}"`
        : 'inline',
      ...(partial
        ? { 'Content-Range': `bytes ${head.start}-${head.end}/${head.size}` }
        : {}),
    });
  }

  private end(stream: Stream): void {
    if (stream.expected === null) {
      this.fail(stream, 502, 'runner-error');
      return;
    }
    if (stream.relayed !== stream.expected) {
      this.destroy(stream, 'short');
      return;
    }
    this.finish(stream, 'complete');
    stream.res.end();
  }

  private runnerError(
    stream: Stream,
    code: string,
    size: number | undefined,
  ): void {
    if (stream.expected !== null) {
      this.destroy(stream, `runner ${code}`.slice(0, 80));
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

  private drained(stream: Stream): void {
    if (this.streams.get(stream.id) !== stream) {
      return;
    }
    for (const bytes of stream.unacked.splice(0)) {
      this.ack(stream, bytes);
    }
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

  /** Answers `{ error }` before the head; after it, the status is sent: destroy. */
  private fail(
    stream: Stream,
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ): void {
    if (stream.res.headersSent) {
      this.destroy(stream, error);
      return;
    }
    this.finish(stream, error);
    stream.res
      .status(status)
      .set({ ...COMMON_HEADERS, ...headers })
      .json({ error });
  }

  /** A short or broken body must never pass as a complete one (Decision 7). */
  private destroy(stream: Stream, outcome: string): void {
    this.finish(stream, outcome);
    stream.res.destroy();
  }

  private finish(stream: Stream, outcome: string): void {
    this.streams.delete(stream.id);
    // Decision 11: no email, no path.
    this.logger.log(
      JSON.stringify({
        event: 'video.stream',
        runId: stream.runId,
        format: stream.format,
        download: stream.download !== undefined,
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
