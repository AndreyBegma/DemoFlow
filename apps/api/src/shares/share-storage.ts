import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Module } from '@nestjs/common';
import type { RunFormat } from '../projects/projects.dto';
import { ShareConfig } from './share-config';

/** A cuid from the database: never a string from a request (Decision 2). */
const SHARE_ID = /^[a-z0-9]+$/;

/**
 * The share directory, `SHARE_DIR` (spec #347, Decision 2): one directory
 * per share, holding `file.<ext>` and `poster.jpg`. Every path is built from
 * a share id the database made, checked here once more before it touches
 * the disk.
 */
@Injectable()
export class ShareStorage {
  constructor(private readonly config: ShareConfig) {}

  dirOf(id: string): string {
    if (!SHARE_ID.test(id)) {
      throw new Error('Not a share id');
    }
    return join(this.config.dir, id);
  }

  /** `mp4`, `gif` or `webm`: the format without its orientation. */
  filePath(id: string, format: RunFormat): string {
    return join(this.dirOf(id), `file.${extensionOf(format)}`);
  }

  posterPath(id: string): string {
    return join(this.dirOf(id), 'poster.jpg');
  }

  /** An empty directory for the share's files. */
  async prepare(id: string): Promise<void> {
    await mkdir(this.dirOf(id), { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Deletes the shares' directories; one already gone is no error. */
  async remove(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map((id) => rm(this.dirOf(id), { recursive: true, force: true })),
    );
  }

  /** The share ids that have a directory. Anything else in `SHARE_DIR` is left. */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.config.dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SHARE_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }
}

export function extensionOf(format: RunFormat): string {
  const [extension] = format.split('-');
  return extension ?? format;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Its own module so the run, project and account deletes can reach the
 * directory without importing the shares module and its controllers.
 */
@Module({
  providers: [ShareConfig, ShareStorage],
  exports: [ShareConfig, ShareStorage],
})
export class ShareStorageModule {}
