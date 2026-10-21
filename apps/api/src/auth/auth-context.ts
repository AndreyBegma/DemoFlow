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

/** What `me` returns: the user, and how they can sign in (spec #126). */
export interface AccountUser extends PublicUser {
  githubLinked: boolean;
  hasPassword: boolean;
}

export function toAccountUser(user: User, githubLinked: boolean): AccountUser {
  return {
    ...toPublicUser(user),
    githubLinked,
    hasPassword: user.passwordHash !== null,
  };
}
