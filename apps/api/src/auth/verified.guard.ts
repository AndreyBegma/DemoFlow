import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth-context';

/**
 * Requires a verified email. Goes after `SessionGuard` —
 * `@UseGuards(SessionGuard, VerifiedGuard)` — and refuses with 401 when used
 * without it, so a missing session guard fails closed.
 */
@Injectable()
export class VerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth) {
      throw new UnauthorizedException();
    }
    if (auth.user.emailVerifiedAt === null) {
      throw new ForbiddenException('Verify your email address first.');
    }
    return true;
  }
}
