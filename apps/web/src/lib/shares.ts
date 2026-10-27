// The owner's share links on the website (spec #350, API from spec #347). Pure,
// so `node --test` runs it as it is: no React, no Node APIs, type imports
// only. The calls live in `shares-client.ts`.

import type { RunDetail, RunRender } from './api';

export type ShareStatus = 'uploading' | 'ready' | 'failed' | 'lost';

/** What the owner sees of a share (`ShareView` in the API). */
export interface Share {
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
  expiresAt: string;
  createdAt: string;
}

export interface ShareQuota {
  usedBytes: number;
  limitBytes: number;
  maxFileBytes: number;
}

export interface SharesList {
  shares: Share[];
  quota: ShareQuota;
}

/** A share's lifetime in days (spec #347, Decision 5). */
export const SHARE_LIFETIMES = [7, 30, 90] as const;
export type ShareLifetime = (typeof SHARE_LIFETIMES)[number];
export const DEFAULT_SHARE_LIFETIME: ShareLifetime = 30;

export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 128;

/** Extend adds this much, never beyond `SHARE_MAX_DAYS` from now. */
export const SHARE_EXTEND_DAYS = 30;
export const SHARE_MAX_DAYS = 90;

/** How often the dialog asks again while a share uploads (Decision 2). */
export const SHARE_POLL_MS = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why the Share button is disabled, or `ready` when it is not (Decision 1). */
export type ShareButtonState =
  | 'ready'
  | 'noRender'
  | 'deleted'
  | 'removed'
  | 'offline'
  | 'outdated';

export function shareButtonState(
  run: { formats: readonly string[]; artifactsDeletedAt: string | null },
  machine: Pick<
    NonNullable<RunDetail['machine']>,
    'online' | 'features'
  > | null,
): ShareButtonState {
  if (run.formats.length === 0) return 'noRender';
  if (run.artifactsDeletedAt !== null) return 'deleted';
  if (machine === null) return 'removed';
  if (!machine.online) return 'offline';
  if (!machine.features?.includes('share')) return 'outdated';
  return 'ready';
}

export interface ShareFormatOption {
  format: string;
  /** Null when the CLI did not report the file's size. */
  sizeBytes: number | null;
  tooLarge: boolean;
}

/**
 * The formats the dialog offers, in the order given, each with its size from
 * the run's renders. A render over `maxFileBytes` cannot be shared.
 */
export function shareFormatOptions(
  formats: readonly string[],
  renders: readonly RunRender[] | null,
  maxFileBytes: number,
): ShareFormatOption[] {
  return formats.map((format) => {
    const sizeBytes =
      renders?.find((render) => render.format === format)?.sizeBytes ?? null;
    return {
      format,
      sizeBytes,
      tooLarge: sizeBytes !== null && sizeBytes > maxFileBytes,
    };
  });
}

/** The first format that can be shared, else the first; null when none. */
export function defaultShareFormat(
  options: readonly ShareFormatOption[],
): string | null {
  return (
    options.find((option) => !option.tooLarge)?.format ??
    options[0]?.format ??
    null
  );
}

export interface QuotaPreview {
  usedBytes: number;
  /** What the quota would hold with the new share; equals used when none. */
  afterBytes: number;
  limitBytes: number;
  fits: boolean;
}

/** The quota with `addBytes` more; an unknown size adds nothing (the API checks it). */
export function quotaPreview(
  quota: Pick<ShareQuota, 'usedBytes' | 'limitBytes'>,
  addBytes: number | null = null,
): QuotaPreview {
  const afterBytes = quota.usedBytes + (addBytes ?? 0);
  return {
    usedBytes: quota.usedBytes,
    afterBytes,
    limitBytes: quota.limitBytes,
    fits: afterBytes <= quota.limitBytes,
  };
}

/** The run's share for `format`, whatever its status: one per run and format. */
export function shareFor(
  shares: readonly Share[],
  runId: string,
  format: string,
): Share | null {
  return (
    shares.find((share) => share.runId === runId && share.format === format) ??
    null
  );
}

/** Whole days until the share expires, rounded up; 0 once it has. */
export function daysLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / DAY_MS));
}

/**
 * Extend is offered while it would add at least a day: the API caps the expiry
 * at 90 days from now and answers `at-max-expiry` beyond it.
 */
export function canExtend(
  share: Pick<Share, 'status' | 'expiresAt'>,
  now: number,
): boolean {
  if (share.status !== 'ready' && share.status !== 'uploading') return false;
  return now + SHARE_MAX_DAYS * DAY_MS - Date.parse(share.expiresAt) >= DAY_MS;
}

export interface ShareRowActions {
  copy: boolean;
  open: boolean;
  extend: boolean;
  revoke: boolean;
  /** A failed upload is tried again from the run page. */
  retry: boolean;
}

/** What a row of `/app/shares` offers (Decision 3). */
export function shareRowActions(
  share: Pick<Share, 'status' | 'expiresAt'>,
  now: number,
): ShareRowActions {
  const ready = share.status === 'ready';
  return {
    copy: ready,
    open: ready,
    extend: canExtend(share, now),
    revoke: true,
    retry: share.status === 'failed',
  };
}

export type SharePasswordError =
  | 'shares.dialog.password.tooShort'
  | 'shares.dialog.password.tooLong';

/** An empty password is none; a set one is taken as typed, never trimmed. */
export function sharePasswordError(value: string): SharePasswordError | null {
  if (value === '') return null;
  if (value.length < SHARE_PASSWORD_MIN) {
    return 'shares.dialog.password.tooShort';
  }
  if (value.length > SHARE_PASSWORD_MAX) {
    return 'shares.dialog.password.tooLong';
  }
  return null;
}

export type ShareErrorKey =
  | 'shares.errors.quotaExceeded'
  | 'shares.errors.fileTooLarge'
  | 'shares.errors.runnerOffline'
  | 'shares.errors.runnerOutdated'
  | 'shares.errors.artifactsDeleted'
  | 'shares.errors.formatNotRendered'
  | 'shares.errors.notFound'
  | 'shares.errors.atMaxExpiry'
  | 'shares.errors.unknown';

const ERRORS: Readonly<Record<string, ShareErrorKey>> = {
  'quota-exceeded': 'shares.errors.quotaExceeded',
  'file-too-large': 'shares.errors.fileTooLarge',
  'runner-offline': 'shares.errors.runnerOffline',
  'runner-outdated': 'shares.errors.runnerOutdated',
  'artifacts-deleted': 'shares.errors.artifactsDeleted',
  'format-not-rendered': 'shares.errors.formatNotRendered',
  'not-found': 'shares.errors.notFound',
  'at-max-expiry': 'shares.errors.atMaxExpiry',
};

/** The message for an API answer's `{ error }` code; anything else is generic. */
export function shareErrorKey(code: string | undefined): ShareErrorKey {
  return (
    (code === undefined ? undefined : ERRORS[code]) ?? 'shares.errors.unknown'
  );
}

export type ShareFailureKey =
  | 'shares.failure.runnerOffline'
  | 'shares.failure.runnerTimeout'
  | 'shares.failure.runnerBusy'
  | 'shares.failure.fileTooLarge'
  | 'shares.failure.quotaExceeded'
  | 'shares.failure.timedOut'
  | 'shares.failure.unknown';

const FAILURES: Readonly<Record<string, ShareFailureKey>> = {
  'runner-offline': 'shares.failure.runnerOffline',
  'runner-timeout': 'shares.failure.runnerTimeout',
  'runner-busy': 'shares.failure.runnerBusy',
  'file-too-large': 'shares.failure.fileTooLarge',
  'quota-exceeded': 'shares.failure.quotaExceeded',
  'timed-out': 'shares.failure.timedOut',
};

/** Why a `failed` share's upload stopped, in words. */
export function shareFailureKey(failure: string | null): ShareFailureKey {
  return (
    (failure === null ? undefined : FAILURES[failure]) ??
    'shares.failure.unknown'
  );
}

/** `![title](fileUrl)`, with the title's brackets escaped, for a GIF. */
export function markdownSnippet(title: string, fileUrl: string): string {
  return `![${title.replace(/[[\]\\]/g, '\\$&')}](${fileUrl})`;
}

/** A GIF gets the Markdown snippet; a video does not. */
export function isGifShare(format: string): boolean {
  return format.startsWith('gif');
}
