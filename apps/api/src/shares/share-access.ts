import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { Clock } from '../common/clock';

/** How long an unlock lasts (spec #348, Decision 5). */
export const SHARE_ACCESS_MS = 12 * 60 * 60 * 1000;
export const SHARE_SIGNING_SECRET_MIN = 32;

const COOKIE_PREFIX = 'df_share_';
/** `<exp>.<hmac>`: seconds since the epoch, then base64url SHA-256. */
const COOKIE_VALUE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** What an unlock is bound to: the share, and its password as it is now. */
export interface LockedShare {
  id: string;
  passwordHash: string;
}

export interface SigningEnv {
  APP_ENV?: string;
  SHARE_SIGNING_SECRET?: string;
}

/**
 * `SHARE_SIGNING_SECRET` (Decision 8): at least 32 characters. Production
 * refuses to start without it; below production a random value per boot is
 * used, so unlocks end at a restart.
 */
export function resolveSigningSecret(env: SigningEnv): string {
  const secret = env.SHARE_SIGNING_SECRET?.trim() || undefined;
  if (secret !== undefined) {
    if (secret.length < SHARE_SIGNING_SECRET_MIN) {
      throw new Error(
        `SHARE_SIGNING_SECRET must be at least ${SHARE_SIGNING_SECRET_MIN} characters.`,
      );
    }
    return secret;
  }
  if (env.APP_ENV === 'production') {
    throw new Error(
      'SHARE_SIGNING_SECRET is not set, and APP_ENV=production does not fall ' +
        'back to a random one. Set it to at least 32 random characters.',
    );
  }
  new Logger('ShareAccess').warn(
    'SHARE_SIGNING_SECRET is not set: share unlocks are signed with a random ' +
      'value and end when the API restarts.',
  );
  return randomBytes(32).toString('base64url');
}

export function shareCookieName(shareId: string): string {
  return `${COOKIE_PREFIX}${shareId}`;
}

/**
 * The hash is signed too, so a later password change voids every unlock made
 * with the old one.
 */
function sign(secret: string, share: LockedShare, exp: number): string {
  return createHmac('sha256', secret)
    .update(`${share.id}.${exp}.${share.passwordHash}`)
    .digest('base64url');
}

export function accessValue(
  secret: string,
  share: LockedShare,
  expiresAtMs: number,
): string {
  const exp = Math.floor(expiresAtMs / 1000);
  return `${exp}.${sign(secret, share, exp)}`;
}

/** True for a value this secret signed for this share that has not expired. */
export function accessAllows(
  secret: string,
  share: LockedShare,
  value: string | undefined,
  nowMs: number,
): boolean {
  const match = value === undefined ? null : COOKIE_VALUE.exec(value);
  if (!match) {
    return false;
  }
  const exp = Number(match[1]);
  if (exp * 1000 <= nowMs) {
    return false;
  }
  const expected = Buffer.from(sign(secret, share, exp));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The unlock cookie of a share with a password (spec #348, Decision 5): one
 * per share, `df_share_<share.id>`, HMAC-signed and good for 12 hours.
 */
@Injectable()
export class ShareAccess {
  private readonly secret: string;
  private readonly secure: boolean;

  constructor(
    config: ConfigService,
    private readonly clock: Clock,
  ) {
    const appEnv = config.get<string>('APP_ENV');
    this.secret = resolveSigningSecret({
      APP_ENV: appEnv,
      SHARE_SIGNING_SECRET: config.get<string>('SHARE_SIGNING_SECRET'),
    });
    // As the session cookie: staging and production run APP_ENV=production.
    this.secure = appEnv === 'production';
  }

  grant(res: Response, share: LockedShare): void {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: SHARE_ACCESS_MS,
    };
    res.cookie(
      shareCookieName(share.id),
      accessValue(
        this.secret,
        share,
        this.clock.now().getTime() + SHARE_ACCESS_MS,
      ),
      options,
    );
  }

  allows(
    cookies: Record<string, unknown> | undefined,
    share: LockedShare,
  ): boolean {
    const value = cookies?.[shareCookieName(share.id)];
    return accessAllows(
      this.secret,
      share,
      typeof value === 'string' ? value : undefined,
      this.clock.now().getTime(),
    );
  }
}
