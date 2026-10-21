import type { User } from '@prisma/client';
import type { Request } from 'express';

/** What `SessionGuard` attaches to a request it lets through. */
export interface AuthContext {
  user: User;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/** The user as the API returns it. */
export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}
