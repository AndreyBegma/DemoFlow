import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Clock } from '../common/clock';
import type { AuthenticatedRequest } from './auth-context';
import { SessionService } from './session.service';
import { SESSION_COOKIE, setSessionCookie } from './session-cookie';

/** Requires a live session cookie. Every signed-in route uses it. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException();
    }

    const resolved = await this.sessions.resolve(token);
    if (!resolved) {
      throw new UnauthorizedException();
    }

    if (resolved.extended) {
      setSessionCookie(
        http.getResponse<Response>(),
        token,
        resolved.expiresAt,
        this.clock.now(),
      );
    }
    req.auth = { user: resolved.user, sessionId: resolved.sessionId };
    return true;
  }
}
