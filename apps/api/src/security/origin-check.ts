import type { NextFunction, Request, Response } from 'express';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF, with the session cookie's `SameSite=Lax` (spec #120, Decision 4): a
 * state-changing request whose `Origin` is present and is not the web app's
 * gets 403. A request without `Origin` passes — it is not a browser riding a
 * cookie.
 */
export function originCheck(webUrl: string) {
  const allowed = new URL(webUrl).origin;
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (
      STATE_CHANGING.has(req.method) &&
      origin !== undefined &&
      origin !== allowed
    ) {
      res.status(403).json({
        statusCode: 403,
        message: 'Cross-origin request refused',
        error: 'Forbidden',
      });
      return;
    }
    next();
  };
}
