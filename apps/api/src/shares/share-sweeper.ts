import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';
import { ShareStorage } from './share-storage';

/** Spec #347, Decision 9. */
export const SHARE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** An upload still running this long after the share was created has failed. */
export const SHARE_UPLOAD_STALE_MS = 15 * 60 * 1000;

export interface SweepResult {
  expired: number;
  timedOut: number;
  orphans: number;
  lost: number;
}

/**
 * Keeps the share directory and the table in step (spec #347, Decision 9):
 * expired shares go with their files, stale uploads fail, directories with
 * no row go, and on boot a ready share whose file is gone is marked lost.
 * The backstop for every cascade that deletes rows before their files.
 */
@Injectable()
export class ShareSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ShareSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ShareStorage,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    void this.run(true);
    this.timer = setInterval(
      () => void this.run(false),
      SHARE_SWEEP_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass. `boot` also checks that every ready share still has its file. */
  async sweep(boot: boolean): Promise<SweepResult> {
    const now = this.clock.now();
    const expired = await this.prisma.share.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true },
    });
    const expiredIds = expired.map(({ id }) => id);
    await this.prisma.share.deleteMany({
      where: { id: { in: expiredIds }, expiresAt: { lte: now } },
    });
    await this.storage.remove(expiredIds);

    const stale = await this.prisma.share.findMany({
      where: {
        status: 'uploading',
        createdAt: { lt: new Date(now.getTime() - SHARE_UPLOAD_STALE_MS) },
      },
      select: { id: true },
    });
    const staleIds = stale.map(({ id }) => id);
    await this.prisma.share.updateMany({
      where: { id: { in: staleIds }, status: 'uploading' },
      data: { status: 'failed', failure: 'timed-out' },
    });
    await this.storage.remove(staleIds);

    const orphans = await this.orphans();
    await this.storage.remove(orphans);

    const lost = boot ? await this.markLost() : [];
    return {
      expired: expiredIds.length,
      timedOut: staleIds.length,
      orphans: orphans.length,
      lost: lost.length,
    };
  }

  private async run(boot: boolean): Promise<void> {
    // A slow pass is not overlapped by the next one.
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.sweep(boot);
      this.logger.log(
        JSON.stringify({ event: 'share.sweep', boot, ...result }),
      );
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.running = false;
    }
  }

  /** Directories with no row. The row is created before its directory. */
  private async orphans(): Promise<string[]> {
    const ids = await this.storage.list();
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.share.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const known = new Set(rows.map(({ id }) => id));
    return ids.filter((id) => !known.has(id));
  }

  /** Not backed up (ADR-0019 §4): the owner uploads a lost share again. */
  private async markLost(): Promise<string[]> {
    const ready = await this.prisma.share.findMany({
      where: { status: 'ready' },
      select: { id: true, format: true },
    });
    const lost: string[] = [];
    for (const { id, format } of ready) {
      const known = RUN_FORMATS.find((candidate) => candidate === format);
      if (!known || !(await this.hasFile(id, known))) {
        lost.push(id);
      }
    }
    await this.prisma.share.updateMany({
      where: { id: { in: lost }, status: 'ready' },
      data: { status: 'lost' },
    });
    return lost;
  }

  private hasFile(id: string, format: RunFormat): Promise<boolean> {
    return this.storage.exists(this.storage.filePath(id, format));
  }
}
