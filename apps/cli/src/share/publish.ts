import path from 'node:path';
import type { RenderFormat } from '@demoflow/core';
import {
  type Fetch,
  readJson,
  ServerError,
  send,
  unexpected,
} from '../auth/client.ts';
import type { Credentials } from '../auth/credentials.ts';
import { readResult } from '../commands/settle.ts';
import {
  type ReportedRun,
  readReportedRunsByDir,
} from '../runs-report/reported-runs.ts';

/** #348: the lifetimes a share can be created with, in days. */
export const SHARE_LIFETIMES = [7, 30, 90] as const;
export type ShareLifetime = (typeof SHARE_LIFETIMES)[number];
export const DEFAULT_SHARE_LIFETIME: ShareLifetime = 30;
/** #348: the API's bounds on a share password. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** Decision 6: `GET /runner/shares/:id` once a second while it uploads. */
export const SHARE_POLL_MS = 1_000;

export type ShareStatus = 'uploading' | 'ready' | 'failed' | 'lost';
const SHARE_STATUSES: readonly string[] = [
  'uploading',
  'ready',
  'failed',
  'lost',
];

/** What the CLI reads of a `ShareView`. */
export interface Share {
  id: string;
  url: string;
  /** `null` when the share has a password. */
  fileUrl: string | null;
  status: ShareStatus;
  failure: string | null;
  expiresAt: string;
  /** The whole `ShareView`, as the server sent it (`--json`). */
  view: Record<string, unknown>;
}

/** Why a share cannot be made; the command and the MCP tool name it so. */
export type ShareRefusalCode =
  | 'not-logged-in'
  | 'invalid-result'
  | 'run-not-reported'
  | 'format-not-rendered'
  | 'artifacts-deleted'
  | 'runner-offline'
  | 'runner-outdated'
  | 'file-too-large'
  | 'quota-exceeded';

export class ShareRefused extends Error {
  readonly code: ShareRefusalCode;

  constructor(code: ShareRefusalCode, message: string) {
    super(message);
    this.name = 'ShareRefused';
    this.code = code;
  }
}

export interface ShareRequest {
  /** The server's run id, from the reported-runs index. */
  runId: string;
  format: RenderFormat;
  expiresInDays: ShareLifetime;
  password?: string;
}

/**
 * The format to share: the one asked for, which the run must have rendered,
 * or the run's first render. The daemon reads the same `result.json`.
 */
export async function shareableFormat(
  runDir: string,
  format: RenderFormat | undefined,
): Promise<RenderFormat> {
  let formats: RenderFormat[];
  try {
    formats = (await readResult(runDir)).renders.map((render) => render.format);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ShareRefused(
      'invalid-result',
      `cannot read the run's result.json: ${reason}`,
    );
  }
  const chosen = format ?? formats[0];
  if (chosen === undefined) {
    throw new ShareRefused(
      'format-not-rendered',
      'the run has no render: make one with demoflow render <runId>',
    );
  }
  if (!formats.includes(chosen)) {
    throw new ShareRefused(
      'format-not-rendered',
      `the run has no ${chosen} render (it has ${formats.join(', ')})`,
    );
  }
  return chosen;
}

/** The run's line in the reported-runs index, if it went to `server`. */
export async function reportedRunOf(
  indexFile: string,
  runDir: string,
  server: string,
): Promise<ReportedRun> {
  const entry = (await readReportedRunsByDir(indexFile)).get(
    path.resolve(runDir),
  );
  if (entry === undefined) {
    throw new ShareRefused(
      'run-not-reported',
      'the run was never reported to the server: it was made signed out or with reporting off',
    );
  }
  if (entry.server !== undefined && entry.server !== server) {
    throw new ShareRefused(
      'run-not-reported',
      `the run was reported to ${entry.server}, not to ${server}`,
    );
  }
  return entry;
}

/**
 * `POST /runner/shares`. A live share of the same run and format is not an
 * error: it is fetched and returned with `existing: true` (Decision 6).
 */
export async function createShare(
  credentials: Credentials,
  request: ShareRequest,
  fetchFn: Fetch,
): Promise<{ share: Share; existing: boolean }> {
  // A second try only for a `share-exists` that raced its own insert.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await send(fetchFn, credentials.server, '/runner/shares', {
      method: 'POST',
      token: credentials.token,
      body: {
        runId: request.runId,
        format: request.format,
        expiresInDays: request.expiresInDays,
        ...(request.password === undefined
          ? {}
          : { password: request.password }),
      },
    });
    if (response.status === 202) {
      return { share: toShare(await readJson(response)), existing: false };
    }
    const body = await errorBody(response);
    if (response.status === 409 && body.error === 'share-exists') {
      if (typeof body.shareId !== 'string') continue;
      return {
        share: await fetchShare(credentials, body.shareId, fetchFn),
        existing: true,
      };
    }
    throw refusal(response.status, body, request.format);
  }
  throw new ServerError('the server keeps answering share-exists', false);
}

/** `GET /runner/shares/:id`. */
export async function fetchShare(
  credentials: Credentials,
  id: string,
  fetchFn: Fetch,
): Promise<Share> {
  const response = await send(
    fetchFn,
    credentials.server,
    `/runner/shares/${encodeURIComponent(id)}`,
    { method: 'GET', token: credentials.token },
  );
  if (response.status === 200) return toShare(await readJson(response));
  if (response.status === 401) {
    throw refusal(401, await errorBody(response), undefined);
  }
  throw unexpected(response.status);
}

export interface WaitDeps {
  fetch: Fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Polls a share until it leaves `uploading` or `timeoutMs` passes, and
 * returns what it last read: still `uploading` on a timeout.
 */
export async function waitForShare(
  credentials: Credentials,
  share: Share,
  deps: WaitDeps,
  options: {
    timeoutMs: number;
    onPoll?(share: Share, elapsedMs: number): void;
  },
): Promise<Share> {
  const started = deps.now();
  let current = share;
  while (current.status === 'uploading') {
    const elapsed = deps.now() - started;
    if (elapsed + SHARE_POLL_MS > options.timeoutMs) break;
    await deps.sleep(SHARE_POLL_MS);
    current = await fetchShare(credentials, current.id, deps.fetch);
    options.onPoll?.(current, deps.now() - started);
  }
  return current;
}

/** `1.5 MB`: what a refusal names a size with. */
export function formatSize(bytes: number): string {
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} kB`;
  if (bytes < 1000 * 1000 * 1000) {
    return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  }
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
}

function refusal(
  status: number,
  body: Record<string, unknown>,
  format: RenderFormat | undefined,
): Error {
  if (status === 401) {
    return new ShareRefused(
      'not-logged-in',
      'the stored token was revoked: run demoflow login',
    );
  }
  if (status === 404) {
    return new ShareRefused(
      'run-not-reported',
      'the server does not know this run on this machine: it was made signed out, with reporting off, or before the last login',
    );
  }
  switch (body.error) {
    case 'format-not-rendered':
      return new ShareRefused(
        'format-not-rendered',
        `the server has no ${format ?? 'such'} render of this run: render it again with demoflow render <runId> while logged in`,
      );
    case 'artifacts-deleted':
      return new ShareRefused(
        'artifacts-deleted',
        "the run's files were deleted on the website",
      );
    case 'runner-offline':
      return new ShareRefused(
        'runner-offline',
        'the runner is offline: start the runner: demoflow runner start',
      );
    case 'runner-outdated':
      return new ShareRefused(
        'runner-outdated',
        'the running runner cannot upload shares: restart the runner (demoflow runner stop, then demoflow runner start)',
      );
    case 'file-too-large':
      return new ShareRefused(
        'file-too-large',
        typeof body.maxFileBytes === 'number'
          ? `the render is over the ${formatSize(body.maxFileBytes)} a share can hold`
          : 'the render is over the size a share can hold',
      );
    case 'quota-exceeded':
      return new ShareRefused(
        'quota-exceeded',
        typeof body.usedBytes === 'number' &&
          typeof body.limitBytes === 'number'
          ? `the share quota is full: ${formatSize(body.usedBytes)} of ${formatSize(body.limitBytes)} used; revoke a share on the website`
          : 'the share quota is full; revoke a share on the website',
      );
  }
  return unexpected(status);
}

/** An error body, or `{}` when it is not JSON: the status then decides. */
async function errorBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return await readJson(response);
  } catch {
    return {};
  }
}

function toShare(body: Record<string, unknown>): Share {
  const { id, url, fileUrl, status, failure, expiresAt } = body;
  if (
    typeof id !== 'string' ||
    typeof url !== 'string' ||
    !(typeof fileUrl === 'string' || fileUrl === null) ||
    typeof status !== 'string' ||
    !SHARE_STATUSES.includes(status) ||
    typeof expiresAt !== 'string'
  ) {
    throw new ServerError('the server sent a share it cannot read', false);
  }
  return {
    id,
    url,
    fileUrl,
    status: status as ShareStatus,
    failure: typeof failure === 'string' ? failure : null,
    expiresAt,
    view: body,
  };
}
