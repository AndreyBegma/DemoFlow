import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Share, type ShareStatus } from '@prisma/client';
import { PasswordHasher } from '../auth/password-hasher';
import { generateToken } from '../auth/tokens';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { parseRenders } from '../projects/projects.service';
import { RunnerConnections } from '../runner/runner-connections.service';
import { ShareConfig } from './share-config';
import { ShareStorage } from './share-storage';
import { ShareUploadService } from './share-upload.service';
import { type CreateShareDto, DEFAULT_SHARE_LIFETIME } from './shares.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `POST /shares/:id/extend` adds this much (spec #347, Decision 5). */
export const SHARE_EXTEND_DAYS = 30;
/** Never beyond this far from now. */
export const SHARE_MAX_DAYS = 90;

/** The statuses whose bytes count against the quota (Decision 3). */
const LIVE: ShareStatus[] = ['uploading', 'ready'];

type ShareWithRun = Share & { run: { projectId: string } };

const SHARE_INCLUDE = {
  run: { select: { projectId: true } },
} satisfies Prisma.ShareInclude;

/** What the owner sees of a share. Never the token's hash, never the password. */
export interface ShareView {
  id: string;
  url: string;
  /** Null while a password is set: the file is served only after unlocking. */
  fileUrl: string | null;
  runId: string;
  projectId: string;
  title: string;
  format: string;
  status: ShareStatus;
  failure: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasPassword: boolean;
  views: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface SharesList {
  shares: ShareView[];
  quota: { usedBytes: number; limitBytes: number; maxFileBytes: number };
}

/** `{ error, ...details }` with a status, as the runs API answers. */
function shareError(
  status: HttpStatus,
  error: string,
  details: Record<string, string | number> = {},
): HttpException {
  return new HttpException({ error, ...details }, status);
}

function notFound(): HttpException {
  return shareError(HttpStatus.NOT_FOUND, 'not-found');
}

/**
 * Share links (spec #347, ADR-0019): created by the run's owner on the
 * website or by the machine that reported the run, uploaded in the
 * background, extended and revoked by the owner. Every query is scoped by
 * the user: another account's share or run answers 404.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly uploads: ShareUploadService,
    private readonly storage: ShareStorage,
    private readonly config: ShareConfig,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
  ) {}

  /**
   * Every check before anything goes to the machine, then the row, then the
   * upload in the background. `runnerId` limits the run to one that machine
   * reported (Decision 7).
   */
  async create(
    userId: string,
    body: CreateShareDto,
    runnerId?: string,
  ): Promise<ShareView> {
    const run = await this.prisma.run.findFirst({
      where: {
        id: body.runId,
        project: { userId },
        ...(runnerId === undefined ? {} : { runnerId }),
      },
      include: { runner: { select: { id: true, revokedAt: true } } },
    });
    if (!run) {
      throw notFound();
    }
    if (!run.formats.includes(body.format)) {
      throw shareError(HttpStatus.CONFLICT, 'format-not-rendered');
    }
    await this.replaceFailed(run.id, body.format);
    if (run.artifactsDeletedAt) {
      throw shareError(HttpStatus.CONFLICT, 'artifacts-deleted');
    }
    // A revoked machine can never serve again: it counts as offline.
    const machine = run.runner?.revokedAt === null ? run.runner : null;
    if (!machine || !this.connections.isOnline(machine.id)) {
      throw shareError(HttpStatus.CONFLICT, 'runner-offline');
    }
    if (!this.connections.features(machine.id).includes('share')) {
      throw shareError(HttpStatus.CONFLICT, 'runner-outdated');
    }
    const render =
      parseRenders(run.renders)?.find(({ format }) => format === body.format) ??
      null;
    // Unknown until the head when the CLI did not report it: checked there.
    const reserved = render?.sizeBytes ?? 0;
    if (reserved > this.config.maxFileBytes) {
      throw shareError(HttpStatus.PAYLOAD_TOO_LARGE, 'file-too-large', {
        maxFileBytes: this.config.maxFileBytes,
      });
    }

    const passwordHash =
      body.password === undefined
        ? null
        : await this.hasher.hash(body.password);
    const now = this.clock.now();
    const days = body.expiresInDays ?? DEFAULT_SHARE_LIFETIME;
    const share = await this.insert(userId, run.id, reserved, {
      token: generateToken(),
      format: body.format,
      title: run.scenarioName,
      sizeBytes: reserved,
      passwordHash,
      expiresAt: new Date(now.getTime() + days * DAY_MS),
    });
    this.log('share.create', share.id, run.id, 'uploading');

    void this.uploads.upload({
      shareId: share.id,
      userId,
      runId: run.id,
      format: body.format,
      runnerId: machine.id,
      render,
    });
    return this.toView(share);
  }

  /** Newest first, with what the quota counts now. */
  async list(userId: string): Promise<SharesList> {
    const [shares, usedBytes] = await Promise.all([
      this.prisma.share.findMany({
        where: { userId, expiresAt: { gt: this.clock.now() } },
        include: SHARE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.usedBytes(this.prisma, userId),
    ]);
    return {
      shares: shares.map((share) => this.toView(share)),
      quota: {
        usedBytes,
        limitBytes: this.config.quotaBytes,
        maxFileBytes: this.config.maxFileBytes,
      },
    };
  }

  async get(userId: string, id: string, runnerId?: string): Promise<ShareView> {
    return this.toView(await this.findOwned(userId, id, runnerId));
  }

  /** 30 more days, never beyond 90 days from now (Decision 5). */
  async extend(userId: string, id: string): Promise<ShareView> {
    const share = await this.findOwned(userId, id);
    const now = this.clock.now().getTime();
    const expiresAt = Math.min(
      Math.max(share.expiresAt.getTime(), now) + SHARE_EXTEND_DAYS * DAY_MS,
      now + SHARE_MAX_DAYS * DAY_MS,
    );
    if (expiresAt <= share.expiresAt.getTime()) {
      throw shareError(HttpStatus.CONFLICT, 'at-max-expiry');
    }
    const updated = await this.prisma.share.update({
      where: { id: share.id },
      data: { expiresAt: new Date(expiresAt) },
      include: SHARE_INCLUDE,
    });
    this.log('share.extend', share.id, share.runId, 'extended');
    return this.toView(updated);
  }

  /** The link stops working at once; the files go after the row (ADR-0019 §5). */
  async remove(userId: string, id: string): Promise<void> {
    // Read first only for the log line: the delete itself is scoped again.
    const share = await this.prisma.share.findFirst({
      where: { id, userId },
      select: { id: true, runId: true },
    });
    if (!share) {
      throw notFound();
    }
    const { count } = await this.prisma.share.deleteMany({
      where: { id: share.id, userId },
    });
    this.log(
      'share.delete',
      share.id,
      share.runId,
      count === 1 ? 'deleted' : 'not-found',
    );
    if (count !== 1) {
      throw notFound();
    }
    await this.storage.remove([share.id]);
  }

  /**
   * A failed or lost share of the same run and format is replaced by a new
   * one: retrying must not need a revoke first. A live one is `share-exists`.
   */
  private async replaceFailed(runId: string, format: string): Promise<void> {
    const existing = await this.prisma.share.findUnique({
      where: { runId_format: { runId, format } },
      select: { id: true, status: true },
    });
    if (!existing) {
      return;
    }
    if (LIVE.includes(existing.status)) {
      throw shareError(HttpStatus.CONFLICT, 'share-exists', {
        shareId: existing.id,
      });
    }
    const { count } = await this.prisma.share.deleteMany({
      where: { id: existing.id, status: { notIn: LIVE } },
    });
    if (count === 1) {
      await this.storage.remove([existing.id]);
      this.log('share.delete', existing.id, runId, 'replaced');
    }
  }

  /**
   * The quota check and the insert under the user's row lock, so two shares
   * created at once cannot both pass it (Decision 3).
   */
  private async insert(
    userId: string,
    runId: string,
    reserved: number,
    data: Omit<Prisma.ShareUncheckedCreateInput, 'userId' | 'runId'>,
  ): Promise<ShareWithRun> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const usedBytes = await this.usedBytes(tx, userId);
        if (usedBytes + reserved > this.config.quotaBytes) {
          throw shareError(HttpStatus.CONFLICT, 'quota-exceeded', {
            usedBytes,
            limitBytes: this.config.quotaBytes,
          });
        }
        return tx.share.create({
          data: { ...data, userId, runId },
          include: SHARE_INCLUDE,
        });
      });
    } catch (error) {
      // Another request shared the same run and format in between.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.share.findUnique({
          where: { runId_format: { runId, format: data.format } },
          select: { id: true },
        });
        throw shareError(HttpStatus.CONFLICT, 'share-exists', {
          ...(existing ? { shareId: existing.id } : {}),
        });
      }
      throw error;
    }
  }

  private async usedBytes(
    db: Prisma.TransactionClient,
    userId: string,
  ): Promise<number> {
    const { _sum } = await db.share.aggregate({
      where: { userId, status: { in: LIVE } },
      _sum: { sizeBytes: true, posterBytes: true },
    });
    return (_sum.sizeBytes ?? 0) + (_sum.posterBytes ?? 0);
  }

  /** An expired share is gone for its owner too, before the sweeper deletes it. */
  private async findOwned(
    userId: string,
    id: string,
    runnerId?: string,
  ): Promise<ShareWithRun> {
    const share = await this.prisma.share.findFirst({
      where: {
        id,
        userId,
        expiresAt: { gt: this.clock.now() },
        ...(runnerId === undefined ? {} : { run: { runnerId } }),
      },
      include: SHARE_INCLUDE,
    });
    if (!share) {
      throw notFound();
    }
    return share;
  }

  private toView(share: ShareWithRun): ShareView {
    const url = `${this.config.webUrl}/s/${share.token}`;
    return {
      id: share.id,
      url,
      fileUrl: share.passwordHash === null ? `${url}/file` : null,
      runId: share.runId,
      projectId: share.run.projectId,
      title: share.title,
      format: share.format,
      status: share.status,
      failure: share.failure,
      sizeBytes: share.sizeBytes,
      width: share.width,
      height: share.height,
      durationMs: share.durationMs,
      hasPassword: share.passwordHash !== null,
      views: share.views,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    };
  }

  /** Decision 10: event, share id, run id, outcome. Nothing else. */
  private log(
    event: string,
    shareId: string,
    runId: string | null,
    outcome: string,
  ): void {
    this.logger.log(JSON.stringify({ event, shareId, runId, outcome }));
  }
}
