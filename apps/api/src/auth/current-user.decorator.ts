import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthContext, AuthenticatedRequest } from './auth-context';

function authOf(context: ExecutionContext): AuthContext {
  const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!auth) {
    throw new InternalServerErrorException('Used without SessionGuard');
  }
  return auth;
}

/** The signed-in user. Only behind `SessionGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => authOf(context).user,
);

/** The user and the session id. Only behind `SessionGuard`. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => authOf(context),
);
