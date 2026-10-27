import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { AuthenticatedRequest } from './auth-context';
import { normalizeEmail } from './email';

const MINUTE_MS = 60 * 1000;

/**
 * The auth rate limits (spec #120, Decision 7), in memory: one API instance.
 * Every throttler is off by default and switched on per route with
 * `@SkipThrottle({ <name>: false })`, so a later route never inherits one by
 * accident.
 */
export const THROTTLE_IP = 'ip';
export const THROTTLE_SIGN_IN = 'sign-in-email';
export const THROTTLE_MAIL = 'mail-email';
/**
 * `demoflow login` polling (spec #135). The CLI polls every 5 s for up to ten
 * minutes, which the shared `ip` budget would cut off after 20 polls.
 */
export const THROTTLE_DEVICE_POLL = 'device-poll';
/** A share's password (spec #348, Decision 6): per address and share token. */
export const THROTTLE_SHARE_UNLOCK = 'share-unlock';
/**
 * Adding a project from a folder (spec #378, Decision 8): per user, across
 * inspect, init and register, so a hijacked session cannot probe a machine.
 */
export const THROTTLE_PROJECT_FOLDERS = 'project-folders';

/** Class-level: every throttler skipped until a route opts in. */
export const SKIP_ALL_THROTTLERS = {
  [THROTTLE_IP]: true,
  [THROTTLE_SIGN_IN]: true,
  [THROTTLE_MAIL]: true,
  [THROTTLE_DEVICE_POLL]: true,
  [THROTTLE_SHARE_UNLOCK]: true,
  [THROTTLE_PROJECT_FOLDERS]: true,
};

export const authThrottlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    {
      name: THROTTLE_IP,
      limit: 20,
      ttl: 10 * MINUTE_MS,
      // `req.ip` honours `trust proxy`; the leftmost X-Forwarded-For entry
      // (`req.ips[0]`) is whatever the client sent.
      getTracker: (req) => `ip:${(req as AuthenticatedRequest).ip ?? ''}`,
    },
    {
      name: THROTTLE_SIGN_IN,
      limit: 5,
      ttl: 15 * MINUTE_MS,
      getTracker: (req) => `email:${bodyEmail(req as AuthenticatedRequest)}`,
    },
    {
      name: THROTTLE_MAIL,
      limit: 3,
      ttl: 60 * MINUTE_MS,
      // Resend has no body: it counts against the signed-in user's address.
      getTracker: (req) => {
        const request = req as AuthenticatedRequest;
        return `email:${request.auth?.user.email ?? bodyEmail(request)}`;
      },
    },
    {
      name: THROTTLE_DEVICE_POLL,
      // Two full ten-minute logins at once from one address (2 × 120 polls).
      limit: 240,
      ttl: 10 * MINUTE_MS,
      getTracker: (req) => `ip:${(req as AuthenticatedRequest).ip ?? ''}`,
    },
    {
      name: THROTTLE_SHARE_UNLOCK,
      limit: 10,
      ttl: 10 * MINUTE_MS,
      getTracker: (req) => {
        const request = req as AuthenticatedRequest;
        return `ip:${request.ip ?? ''}:share:${routeToken(request)}`;
      },
    },
    {
      name: THROTTLE_PROJECT_FOLDERS,
      limit: 30,
      ttl: MINUTE_MS,
      // Behind `SessionGuard`: there is always a user.
      getTracker: (req) =>
        `user:${(req as AuthenticatedRequest).auth?.user.id ?? ''}`,
    },
  ],
  // The default key includes the route, which would give each endpoint its
  // own budget. The limits are across the auth endpoints.
  generateKey: (_context: ExecutionContext, tracker: string, name: string) =>
    `${name}:${tracker}`,
};

/** Guards run after routing: `:token` is already parsed. */
function routeToken(req: AuthenticatedRequest): string {
  const token: unknown = req.params?.token;
  return typeof token === 'string' ? token : '';
}

/** Guards run before the validation pipe, so the body is still raw here. */
function bodyEmail(req: AuthenticatedRequest): string {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('email' in body)) {
    return '';
  }
  const email = normalizeEmail(body.email);
  return typeof email === 'string' ? email : '';
}
