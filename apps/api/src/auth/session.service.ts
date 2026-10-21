import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { generateToken, hashToken } from './tokens';

/** A session lasts 30 days after it was last used (spec #120, Decision 2). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `expiresAt` moves at most once an hour, so a request rarely costs a write. */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;
const USER_AGENT_MAX = 256;

export interface ResolvedSession {
  user: User;
  sessionId: string;
  expiresAt: Date;
  /** True when `expiresAt` just moved, so the cookie's Max-Age must too. */
  extended: boolean;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async create(
    userId: string,
    userAgent: string | undefined,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        expiresAt,
        lastSeenAt: now,
        userAgent: userAgent?.slice(0, USER_AGENT_MAX) ?? null,
      },
    });
    return { token, expiresAt };
  }

  /** The session a cookie token names, or null when there is none or it expired. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session) {
      return null;
    }

    const now = this.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    if (
      now.getTime() - session.lastSeenAt.getTime() <
      SESSION_SLIDE_INTERVAL_MS
    ) {
      return {
        user: session.user,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        extended: false,
      };
    }

    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { expiresAt, lastSeenAt: now },
    });
    return {
      user: session.user,
      sessionId: session.id,
      expiresAt,
      extended: true,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }
}
