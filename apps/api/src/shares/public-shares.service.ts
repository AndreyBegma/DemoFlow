import { type FileHandle, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Share } from '@prisma/client';
import type { Request, Response } from 'express';
import { PasswordHasher } from '../auth/password-hasher';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';
import { parseRange, spanOf } from '../videos/byte-range';
import { type DownloadNameRun, downloadName } from '../videos/download-name';
import { VIDEO_CONTENT_TYPES } from '../videos/video-relay.service';
import { ShareAccess } from './share-access';
import { ShareConfig } from './share-config';
import { ShareStorage } from './share-storage';

/**
 * `generateToken()`: 32 random bytes, base64url. Caddy routes
 * `/s/<token>/file` and `/s/<token>/poster` with the same pattern (Decision 1).
 */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** `kind` is `image` for the GIF formats (Decision 3). */
export type ShareKind = 'video' | 'image';

export interface ShareChapter {
  title: string;
  atMs: number;
}

/** What the share page shows (Decision 3). Nothing that names an owner, a run or a share id. */
export interface ShareData {
  title: string;
  description: string | null;
  chapters: ShareChapter[];
  format: RunFormat;
  kind: ShareKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sizeBytes: number;
  expiresAt: Date;
  fileUrl: string;
  posterUrl: string;
  downloadUrl: string;
}

/** A share with a password, before its cookie: nothing about the video. */
export interface LockedSharePage {
  locked: true;
}

export type SharePage = ShareData | LockedSharePage;

export type ShareAsset = 'file' | 'poster';

type PublicShare = Share & { run: DownloadNameRun };

/** `{ error }` with a status, as the owner's share API answers. */
function publicError(status: HttpStatus, error: string): HttpException {
  return new HttpException({ error }, status);
}

function notFound(): HttpException {
  return publicError(HttpStatus.NOT_FOUND, 'not-found');
}

function unavailable(): HttpException {
  return publicError(HttpStatus.GONE, 'unavailable');
}

/** Not `instanceof Error`: Node's fs errors can come from another realm. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function parseChapters(value: unknown): ShareChapter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { title, atMs } = entry as Record<string, unknown>;
    return typeof title === 'string' && typeof atMs === 'number'
      ? [{ title, atMs }]
      : [];
  });
}

/**
 * What a viewer without an account reaches (spec #348, ADR-0019 §5): the
 * share page's data, its file and poster, and the password unlock. Only the
 * token opens a share; expiry is checked on every request, before the
 * sweeper cleans up. Nothing about the viewer is stored or logged.
 */
@Injectable()
export class PublicSharesService {
  private readonly logger = new Logger(PublicSharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ShareStorage,
    private readonly config: ShareConfig,
    private readonly access: ShareAccess,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
  ) {}

  /** `GET /s/:token`. Counts a view only when it returns the data (Decision 7). */
  async page(
    token: string,
    cookies: Record<string, unknown> | undefined,
  ): Promise<SharePage> {
    const share = await this.resolve(token);
    const format = await this.formatOf(share);
    if (!(await this.storage.exists(this.storage.filePath(share.id, format)))) {
      await this.markLost(share.id);
      throw unavailable();
    }
    if (!this.opens(share, cookies)) {
      return { locked: true };
    }
    await this.prisma.share.updateMany({
      where: { id: share.id },
      data: { views: { increment: 1 } },
    });
    return this.toData(share, token, format);
  }

  /**
   * `POST /s/:token/unlock`. Right: the cookie. A share without a password
   * has nothing to unlock and answers the same, without one.
   */
  async unlock(token: string, password: string, res: Response): Promise<void> {
    const share = await this.resolve(token);
    if (share.passwordHash === null) {
      return;
    }
    if (!(await this.hasher.verify(share.passwordHash, password))) {
      throw publicError(HttpStatus.UNAUTHORIZED, 'wrong-password');
    }
    this.access.grant(res, { id: share.id, passwordHash: share.passwordHash });
  }

  /** `GET|HEAD /s/:token/file` and `/s/:token/poster`, with byte ranges (Decision 4). */
  async serve(
    req: Request,
    res: Response,
    token: string,
    asset: ShareAsset,
    download: boolean,
  ): Promise<void> {
    const share = await this.resolve(token);
    if (!this.opens(share, req.cookies)) {
      throw publicError(HttpStatus.FORBIDDEN, 'locked');
    }
    const format = await this.formatOf(share);
    const path =
      asset === 'file'
        ? this.storage.filePath(share.id, format)
        : this.storage.posterPath(share.id);
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // The poster alone missing leaves the video playable.
      if (asset === 'file') {
        await this.markLost(share.id);
      }
      throw unavailable();
    }

    let streaming = false;
    try {
      const { size } = await handle.stat();
      const range = parseRange(req.headers.range);
      const span = spanOf(range, size);
      const headers: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        // Without a password the file embeds in another site; with one it
        // stays behind the cookie (ADR-0019 §5).
        ...(share.passwordHash === null
          ? {
              'Cache-Control': 'public, max-age=300',
              'Cross-Origin-Resource-Policy': 'cross-origin',
            }
          : { 'Cache-Control': 'private, no-store' }),
      };
      if (span === null && range !== null) {
        res.writeHead(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, {
          ...headers,
          'Content-Range': `bytes */${size}`,
        });
        res.end();
        return;
      }
      const partial = range !== null && span !== null;
      res.writeHead(partial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK, {
        ...headers,
        'Content-Type':
          asset === 'file' ? VIDEO_CONTENT_TYPES[format] : 'image/jpeg',
        'Content-Length': String(span === null ? 0 : span.end - span.start + 1),
        'Content-Disposition':
          asset === 'file' && download
            ? `attachment; filename="${downloadName(share.run, format)}"`
            : 'inline',
        ...(partial
          ? { 'Content-Range': `bytes ${span.start}-${span.end}/${size}` }
          : {}),
      });
      if (req.method === 'HEAD' || span === null) {
        res.end();
        return;
      }
      streaming = true;
      // A viewer closing the tab mid-file is no error.
      await pipeline(
        handle.createReadStream({ start: span.start, end: span.end }),
        res,
      ).catch(() => undefined);
    } finally {
      if (!streaming) {
        await handle.close();
      }
    }
  }

  /**
   * The Decision 2 table, up to the file: unknown, uploading and failed are
   * 404; expired and lost are 410.
   */
  private async resolve(token: string): Promise<PublicShare> {
    if (!SHARE_TOKEN.test(token)) {
      throw notFound();
    }
    const share = await this.prisma.share.findUnique({
      where: { token },
      include: {
        run: {
          select: { scenarioName: true, scenarioPath: true, startedAt: true },
        },
      },
    });
    if (!share || (share.status !== 'ready' && share.status !== 'lost')) {
      throw notFound();
    }
    if (share.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw publicError(HttpStatus.GONE, 'expired');
    }
    if (share.status === 'lost') {
      throw unavailable();
    }
    return share;
  }

  private opens(
    share: PublicShare,
    cookies: Record<string, unknown> | undefined,
  ): boolean {
    return (
      share.passwordHash === null ||
      this.access.allows(cookies, {
        id: share.id,
        passwordHash: share.passwordHash,
      })
    );
  }

  /** A format the API no longer knows has no file it can name: lost. */
  private async formatOf(share: PublicShare): Promise<RunFormat> {
    const format = RUN_FORMATS.find((known) => known === share.format);
    if (format === undefined) {
      await this.markLost(share.id);
      throw unavailable();
    }
    return format;
  }

  /** Not backed up (ADR-0019 §4): the owner shares the run again. */
  private async markLost(id: string): Promise<void> {
    const { count } = await this.prisma.share.updateMany({
      where: { id, status: 'ready' },
      data: { status: 'lost' },
    });
    if (count === 1) {
      // As the owner's API logs (spec #347, Decision 10): never the token.
      this.logger.log(
        JSON.stringify({ event: 'share.lost', shareId: id, outcome: 'lost' }),
      );
    }
  }

  private toData(
    share: PublicShare,
    token: string,
    format: RunFormat,
  ): ShareData {
    const fileUrl = `${this.config.webUrl}/s/${token}/file`;
    return {
      title: share.title,
      description: share.description,
      chapters: parseChapters(share.chapters),
      format,
      kind: format.startsWith('gif') ? 'image' : 'video',
      width: share.width,
      height: share.height,
      durationMs: share.durationMs,
      sizeBytes: share.sizeBytes,
      expiresAt: share.expiresAt,
      fileUrl,
      posterUrl: `${this.config.webUrl}/s/${token}/poster`,
      downloadUrl: `${fileUrl}?download=1`,
    };
  }
}
