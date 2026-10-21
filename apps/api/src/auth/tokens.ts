import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, base64url: a session cookie or an emailed link. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of a token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
