import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';

export const OAUTH_COOKIE = 'df_oauth';
/** How long the browser has to come back from GitHub (spec #126). */
export const OAUTH_TTL_MS = 10 * 60 * 1000;

export type GithubIntent = 'sign-in' | 'link';

/** What the browser carries between `start` and `callback`. */
export interface OauthState {
  state: string;
  codeVerifier: string;
  intent: GithubIntent;
  /** The user who started a link; the callback must see the same session. */
  userId: string | null;
  expiresAt: number;
}

function options(): CookieOptions {
  return {
    httpOnly: true,
    // Lax: the cookie must come back on GitHub's top-level redirect.
    sameSite: 'lax',
    path: '/',
    secure: process.env.APP_ENV === 'production',
  };
}

function mac(payload: string, key: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * `<payload>.<mac>`, both base64url. The key is the OAuth App's client secret:
 * the cookie exists only while that secret is set.
 */
export function sealOauthState(value: OauthState, key: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${mac(payload, key).toString('base64url')}`;
}

/** The state a cookie carries, or null when it is missing, forged or expired. */
export function openOauthState(
  raw: unknown,
  key: string,
  now: Date,
): OauthState | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const [payload, signature, ...rest] = raw.split('.');
  if (!payload || !signature || rest.length > 0) {
    return null;
  }
  const expected = mac(payload, key);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isOauthState(parsed) || parsed.expiresAt <= now.getTime()) {
    return null;
  }
  return parsed;
}

export function setOauthCookie(res: Response, sealed: string): void {
  res.cookie(OAUTH_COOKIE, sealed, { ...options(), maxAge: OAUTH_TTL_MS });
}

export function clearOauthCookie(res: Response): void {
  res.clearCookie(OAUTH_COOKIE, options());
}

function isOauthState(value: unknown): value is OauthState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.codeVerifier === 'string' &&
    (v.intent === 'sign-in' || v.intent === 'link') &&
    (v.userId === null || typeof v.userId === 'string') &&
    typeof v.expiresAt === 'number'
  );
}
