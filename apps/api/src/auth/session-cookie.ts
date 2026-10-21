import type { CookieOptions, Response } from 'express';

export const SESSION_COOKIE = 'df_session';

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.APP_ENV === 'production',
  };
}

/** Max-Age is the session's remaining lifetime. */
export function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  res.cookie(SESSION_COOKIE, token, {
    ...baseOptions(),
    maxAge: Math.max(0, expiresAt.getTime() - now.getTime()),
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, baseOptions());
}
