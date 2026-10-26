import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 200 MB (spec #347, Decision 3). */
export const DEFAULT_SHARE_MAX_FILE_BYTES = 209_715_200;
/** 2 GB per user. */
export const DEFAULT_SHARE_USER_QUOTA_BYTES = 2_147_483_648;

/**
 * Where shared files live and how much of them a user may keep (spec #347,
 * Configuration). A limit that is set but not a positive integer stops the
 * API at boot rather than falling back silently.
 */
@Injectable()
export class ShareConfig {
  /** Absolute: `SHARE_DIR` resolved against the API's working directory. */
  readonly dir: string;
  readonly maxFileBytes: number;
  readonly quotaBytes: number;
  /** The web origin a share's link points at. */
  readonly webUrl: string;

  constructor(config: ConfigService) {
    this.dir = resolve(
      config.get<string>('SHARE_DIR')?.trim() || './data/shares',
    );
    this.maxFileBytes = bytes(
      config,
      'SHARE_MAX_FILE_BYTES',
      DEFAULT_SHARE_MAX_FILE_BYTES,
    );
    this.quotaBytes = bytes(
      config,
      'SHARE_USER_QUOTA_BYTES',
      DEFAULT_SHARE_USER_QUOTA_BYTES,
    );
    this.webUrl = (
      config.get<string>('WEB_URL') ?? 'http://localhost:3670'
    ).replace(/\/+$/, '');
  }
}

function bytes(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string>(name)?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
