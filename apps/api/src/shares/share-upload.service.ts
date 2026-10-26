import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import type { RunFormat } from '../projects/projects.dto';
import type { RunRender } from '../projects/projects.service';
import {
  RunnerConnections,
  type ShareSink,
} from '../runner/runner-connections.service';
import {
  MAX_STREAMS_PER_RUNNER,
  SHARE_POSTER_MAX_BYTES,
  type ShareMessage,
} from '../runner/runner-socket';
import {
  type UploadOutcome,
  type UploadVideo,
  VideoRelay,
} from '../videos/video-relay.service';
import { ShareConfig } from './share-config';
import { ShareStorage } from './share-storage';

/** No answer this long after `share.prepare`: the share fails (spec #347, Decision 4). */
export const PREPARE_TIMEOUT_MS = 30 * 1000;
/** How often the timeout is checked. */
const SWEEP_INTERVAL_MS = 1000;

/** What the daemon answered to `share.prepare`. */
interface Prepared {
  description: string | null;
  chapters: Array<{ title: string; atMs: number }>;
}

type PrepareOutcome =
  | { ok: true; prepared: Prepared }
  | { ok: false; error: string };

interface Pending {
  id: string;
  runnerId: string;
  /** Clock ms. */
  sentAt: number;
  settle: (outcome: PrepareOutcome) => void;
}

/** One share's upload: which machine, which file, and what the run reported. */
export interface ShareUpload {
  shareId: string;
  userId: string;
  runId: string;
  format: RunFormat;
  runnerId: string;
  /** The run's `renders` entry for the format; null when the CLI did not report it. */
  render: RunRender | null;
}

/**
 * Pulls a share's files from the machine that recorded the run (spec #347,
 * Decision 4, ADR-0019 §3): `share.prepare`, then the poster and the render
 * through `VideoRelay` into the share's directory. The row ends `ready`, or
 * `failed` with its files deleted.
 *
 * Works only on the instance that holds the Runner's socket, like the relay.
 */
@Injectable()
export class ShareUploadService
  implements ShareSink, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShareUploadService.name);
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: RunnerConnections,
    private readonly relay: VideoRelay,
    private readonly prisma: PrismaService,
    private readonly storage: ShareStorage,
    private readonly config: ShareConfig,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setShareSink(this);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Uploads the share's files and records the outcome. Never throws: a share
   * that cannot be uploaded ends `failed`. Settles once the row says so.
   */
  async upload(target: ShareUpload): Promise<void> {
    const startedAt = this.clock.now().getTime();
    let outcome: string;
    try {
      outcome = await this.pull(target);
    } catch (error) {
      this.logger.error(error);
      outcome = 'error';
    }
    if (outcome !== 'ready') {
      await this.fail(target.shareId, outcome);
    }
    // Decision 10: never the token, the password, the title or the description.
    this.logger.log(
      JSON.stringify({
        event: 'share.upload',
        shareId: target.shareId,
        runId: target.runId,
        outcome,
        durationMs: this.clock.now().getTime() - startedAt,
      }),
    );
  }

  message(runnerId: string, message: ShareMessage): boolean {
    const request = this.pending.get(message.requestId);
    // Only the machine a request was sent to can answer it.
    if (request?.runnerId !== runnerId) {
      return false;
    }
    if (message.type === 'share.prepared') {
      this.settle(request, {
        ok: true,
        prepared: {
          description: message.description ?? null,
          chapters: message.chapters.map(({ title, atMs }) => ({
            title,
            atMs,
          })),
        },
      });
    } else {
      this.settle(request, { ok: false, error: message.code });
    }
    return true;
  }

  /** Every request on the machine's socket ends with it. */
  closed(runnerId: string): void {
    for (const request of [...this.pending.values()]) {
      if (request.runnerId === runnerId) {
        this.settle(request, { ok: false, error: 'runner-offline' });
      }
    }
  }

  /** The timeout, on the injected clock. Runs every `SWEEP_INTERVAL_MS`. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const request of [...this.pending.values()]) {
      if (now - request.sentAt >= PREPARE_TIMEOUT_MS) {
        this.settle(request, { ok: false, error: 'runner-timeout' });
      }
    }
  }

  /** `ready`, or the code the share fails with. */
  private async pull(target: ShareUpload): Promise<string> {
    const { shareId, userId, runnerId, runId, format, render } = target;
    await this.storage.prepare(shareId);
    const prepare = await this.prepare(runnerId, runId, format);
    if (!prepare.ok) {
      return prepare.error;
    }

    const poster = await this.stream({
      runnerId,
      runId,
      format,
      asset: 'poster',
      path: this.storage.posterPath(shareId),
      accept: (size) =>
        size > SHARE_POSTER_MAX_BYTES ? 'poster-too-large' : null,
    });
    if (!poster.ok) {
      return poster.error;
    }

    // Read once, so the head's check stays synchronous. A share created
    // meanwhile reserved its bytes under the user's lock and is counted.
    const others = await this.usedBytes(userId, shareId);
    const file = await this.stream({
      runnerId,
      runId,
      format,
      path: this.storage.filePath(shareId, format),
      accept: (size) => {
        if (size > this.config.maxFileBytes) {
          return 'file-too-large';
        }
        if (others + poster.size + size > this.config.quotaBytes) {
          return 'quota-exceeded';
        }
        return null;
      },
    });
    if (!file.ok) {
      return file.error;
    }

    // Only an upload still running may finish: a revoked or swept share stays gone.
    const { count } = await this.prisma.share.updateMany({
      where: { id: shareId, status: 'uploading' },
      data: {
        status: 'ready',
        failure: null,
        sizeBytes: file.size,
        posterBytes: poster.size,
        description: prepare.prepared.description,
        chapters: prepare.prepared.chapters,
        width: render?.width ?? null,
        height: render?.height ?? null,
        durationMs: render?.durationMs ?? null,
      },
    });
    if (count !== 1) {
      await this.storage.remove([shareId]);
      return 'gone';
    }
    return 'ready';
  }

  /** As playback: a fifth stream to the machine is `runner-busy`. */
  private stream(upload: UploadVideo): Promise<UploadOutcome> {
    if (this.relay.openTo(upload.runnerId) >= MAX_STREAMS_PER_RUNNER) {
      return Promise.resolve({ ok: false, error: 'runner-busy' });
    }
    return this.relay.upload(upload);
  }

  private prepare(
    runnerId: string,
    runId: string,
    format: RunFormat,
  ): Promise<PrepareOutcome> {
    return new Promise((settle) => {
      const request: Pending = {
        id: randomUUID(),
        runnerId,
        sentAt: this.clock.now().getTime(),
        settle,
      };
      this.pending.set(request.id, request);
      const sent = this.connections.sendTo(runnerId, {
        type: 'share.prepare',
        requestId: request.id,
        runId,
        format,
      });
      if (!sent) {
        this.settle(request, { ok: false, error: 'runner-offline' });
      }
    });
  }

  private settle(request: Pending, outcome: PrepareOutcome): void {
    this.pending.delete(request.id);
    request.settle(outcome);
  }

  /** The user's live shares other than this one: what the quota counts. */
  private async usedBytes(userId: string, exceptId: string): Promise<number> {
    const { _sum } = await this.prisma.share.aggregate({
      where: {
        userId,
        id: { not: exceptId },
        status: { in: ['uploading', 'ready'] },
      },
      _sum: { sizeBytes: true, posterBytes: true },
    });
    return (_sum.sizeBytes ?? 0) + (_sum.posterBytes ?? 0);
  }

  /** The files go, and with them the bytes the quota counted. */
  private async fail(shareId: string, failure: string): Promise<void> {
    try {
      await this.prisma.share.updateMany({
        where: { id: shareId, status: 'uploading' },
        data: { status: 'failed', failure: failure.slice(0, 64) },
      });
      await this.storage.remove([shareId]);
    } catch (error) {
      // The sweeper fails a stale upload and deletes its directory.
      this.logger.error(error);
    }
  }
}
