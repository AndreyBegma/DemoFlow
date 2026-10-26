// The public share page (spec #351): the fetch of `GET /s/:token` (spec #348)
// and the pure logic around it. No React, no Next, no Node APIs, so
// `node --test` runs it as it is.

import type { PlayerShape } from './playback';

/** A scene of the scenario, as a chapter of the video. */
export interface ShareChapter {
  title: string;
  atMs: number;
}

/** What `GET /s/:token` answers for an open share (spec #348, Decision 3). */
export interface ShareData {
  title: string;
  description: string | null;
  chapters: ShareChapter[];
  format: string;
  kind: 'video' | 'image';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sizeBytes: number;
  expiresAt: string;
  fileUrl: string;
  posterUrl: string;
  downloadUrl: string;
}

/** What the page renders (Decision 1). */
export type SharePageState =
  | { kind: 'share'; share: ShareData }
  | { kind: 'locked' }
  | { kind: 'not-found' }
  | { kind: 'expired' }
  | { kind: 'unavailable' }
  | { kind: 'error' };

/** The state for an answer of `GET /s/:token`: its status and JSON body. */
export function sharePageState(status: number, body: unknown): SharePageState {
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (status === 200) {
    if (record.locked === true) return { kind: 'locked' };
    if (typeof record.title === 'string' && typeof record.fileUrl === 'string')
      return { kind: 'share', share: body as ShareData };
    return { kind: 'error' };
  }
  if (status === 404) return { kind: 'not-found' };
  if (status === 410)
    return record.error === 'expired'
      ? { kind: 'expired' }
      : { kind: 'unavailable' };
  return { kind: 'error' };
}

/**
 * Asks the API for a share, on its internal origin with the viewer's cookies,
 * so an unlock cookie opens a protected share. A network failure is `error`.
 */
export async function fetchSharePage(
  token: string,
  { baseUrl, cookie }: { baseUrl: string; cookie: string },
): Promise<SharePageState> {
  try {
    const response = await fetch(`${baseUrl}/s/${encodeURIComponent(token)}`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return sharePageState(response.status, body);
  } catch {
    return { kind: 'error' };
  }
}

/** `mm:ss`, or `h:mm:ss` from an hour on: a chapter's start. */
export function chapterTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
}

/**
 * The player's box for a picture of `width` × `height`: wider than tall is
 * 16:9, taller than wide is 9:16, roughly even is 1:1. Unknown is 16:9.
 */
export function shareShape(
  width: number | null,
  height: number | null,
): PlayerShape {
  if (!width || !height) return 'landscape';
  const ratio = width / height;
  if (ratio > 1.2) return 'landscape';
  if (ratio < 1 / 1.2) return 'vertical';
  return 'square';
}

/**
 * The path and query of one of the API's absolute share URLs. The page plays
 * and downloads on its own origin, so the unlock cookie goes with the request
 * whatever origin the API was configured with.
 */
export function samePath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
}

/**
 * True when the request carries an unlock cookie (`df_share_<id>`, spec #348,
 * Decision 5). `ShareData` does not say whether the share has a password, so
 * a request with one may be reading a protected share.
 */
export function hasUnlockCookie(cookie: string): boolean {
  return cookie.split(';').some((part) => part.trim().startsWith('df_share_'));
}

/**
 * Unfurlers get the file as `og:video` only for an MP4 share known to have
 * no password: a request without any unlock cookie (Decision 5).
 */
export function unfurlsVideo(share: ShareData, cookie: string): boolean {
  return (
    share.kind === 'video' &&
    share.format.startsWith('mp4') &&
    !hasUnlockCookie(cookie)
  );
}

export type UnlockOutcome =
  | 'unlocked'
  | 'wrong-password'
  | 'rate-limited'
  | 'changed'
  | 'error';

/**
 * What an answer of `POST /s/:token/unlock` means (Decision 4). A password
 * the API refuses to check (too short or too long) cannot be the right one;
 * a share that expired or went away meanwhile is `changed`, and the page
 * fetches again to show it.
 */
export function unlockOutcome(status: number): UnlockOutcome {
  if (status >= 200 && status < 300) return 'unlocked';
  if (status === 400 || status === 401) return 'wrong-password';
  if (status === 429) return 'rate-limited';
  if (status === 404 || status === 410) return 'changed';
  return 'error';
}

/** Posts the password from the browser; the API sets the unlock cookie. */
export async function unlockShare(
  token: string,
  password: string,
): Promise<UnlockOutcome> {
  try {
    const response = await fetch(`/api/s/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return unlockOutcome(response.status);
  } catch {
    return 'error';
  }
}
