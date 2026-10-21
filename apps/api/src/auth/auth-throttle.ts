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

/** Class-level: every throttler skipped until a route opts in. */
export const SKIP_ALL_THROTTLERS = {
  [THROTTLE_IP]: true,
  [THROTTLE_SIGN_IN]: true,
  [THROTTLE_MAIL]: true,
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
  ],
  // The default key includes the route, which would give each endpoint its
  // own budget. The limits are across the auth endpoints.
  generateKey: (_context: ExecutionContext, tracker: string, name: string) =>
    `${name}:${tracker}`,
};

/** Guards run before the validation pipe, so the body is still raw here. */
function bodyEmail(req: AuthenticatedRequest): string {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('email' in body)) {
    return '';
  }
  const email = normalizeEmail(body.email);
  return typeof email === 'string' ? email : '';
}
