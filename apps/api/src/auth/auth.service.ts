import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailTokenPurpose, Prisma, type User } from '@prisma/client';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { Mailer } from '../mail/mailer';
import {
  alreadyRegisteredMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from '../mail/messages';
import { PasswordHasher } from './password-hasher';
import { SessionService } from './session.service';
import { generateToken, hashToken } from './tokens';

const HOUR_MS = 60 * 60 * 1000;
/** How long an emailed link works (spec #120, Decision 6). */
const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  VERIFY_EMAIL: 24 * HOUR_MS,
  RESET_PASSWORD: HOUR_MS,
};

/** One body for every failed sign-in, so it never says whether the email exists. */
export const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_LINK = 'This link is invalid or has expired.';

export interface SignedIn {
  user: User;
  token: string;
  expiresAt: Date;
}

/** The email/password flows. Emails arrive normalized by the DTOs. */
@Injectable()
export class AuthService {
  private readonly webUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordHasher,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.webUrl = (
      config.get<string>('WEB_URL') ?? 'http://localhost:3670'
    ).replace(/\/+$/, '');
  }

  /**
   * Creates the account and emails a verification link, or — when the address
   * is taken — emails the owner a notice and creates nothing. The caller sees
   * the same result either way.
   */
  async signUp(email: string, password: string): Promise<void> {
    // Hashed before the lookup, so both branches cost an argon2 hash.
    const passwordHash = await this.passwords.hash(password);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      await this.mailer.send(alreadyRegisteredMessage(email));
      return;
    }

    let user: User;
    try {
      user = await this.prisma.user.create({ data: { email, passwordHash } });
    } catch (error) {
      // Lost a race with another sign-up for the same address.
      if (isUniqueViolation(error)) {
        await this.mailer.send(alreadyRegisteredMessage(email));
        return;
      }
      throw error;
    }
    await this.sendVerification(user);
  }

  async signIn(
    email: string,
    password: string,
    userAgent: string | undefined,
  ): Promise<SignedIn> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = await this.passwords.verify(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !ok) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    const session = await this.sessions.create(user.id, userAgent);
    return { user, ...session };
  }

  async verifyEmail(token: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const userId = await consumeToken(tx, token, 'VERIFY_EMAIL', now);
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
    });
  }

  /** A no-op when the address is already verified. */
  async resendVerification(user: User): Promise<void> {
    if (user.emailVerifiedAt !== null) {
      return;
    }
    await this.sendVerification(user);
  }

  /** Emails a reset link when the account exists; silent otherwise. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      return;
    }
    const token = await this.issueToken(user.id, 'RESET_PASSWORD');
    await this.mailer.send(
      resetPasswordMessage(user.email, this.link('/reset-password', token)),
    );
  }

  /**
   * Sets the new password and signs the user out everywhere. Does not sign
   * them in, and does not mark the email verified.
   */
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const userId = await consumeToken(tx, token, 'RESET_PASSWORD', now);
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.emailToken.deleteMany({
        where: { userId, purpose: 'RESET_PASSWORD', usedAt: null },
      });
    });
  }

  private async sendVerification(user: User): Promise<void> {
    const token = await this.issueToken(user.id, 'VERIFY_EMAIL');
    await this.mailer.send(
      verifyEmailMessage(user.email, this.link('/verify-email', token)),
    );
  }

  /** A new link replaces the user's earlier unused links of the same purpose. */
  private async issueToken(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<string> {
    const token = generateToken();
    const now = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.emailToken.deleteMany({
        where: { userId, purpose, usedAt: null },
      }),
      this.prisma.emailToken.create({
        data: {
          tokenHash: hashToken(token),
          userId,
          purpose,
          expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
        },
      }),
    ]);
    return token;
  }

  private link(path: string, token: string): string {
    return `${this.webUrl}${path}?token=${encodeURIComponent(token)}`;
  }
}

/**
 * Marks a link used and returns its user, or throws 400 when it is unknown,
 * of another purpose, used or expired. The conditional update makes two
 * concurrent uses of one link succeed at most once.
 */
async function consumeToken(
  tx: Prisma.TransactionClient,
  token: string,
  purpose: EmailTokenPurpose,
  now: Date,
): Promise<string> {
  const row = await tx.emailToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.purpose !== purpose) {
    throw new BadRequestException(INVALID_LINK);
  }
  const { count } = await tx.emailToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count !== 1) {
    throw new BadRequestException(INVALID_LINK);
  }
  return row.userId;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
