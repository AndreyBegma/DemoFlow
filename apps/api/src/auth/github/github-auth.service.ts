import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../database/prisma.service';
import { isUniqueViolation } from '../auth.service';
import { normalizeEmail } from '../email';
import { SessionService } from '../session.service';
import { generateToken } from '../tokens';
import {
  GithubClient,
  type GithubEmail,
  GithubRequestError,
  type GithubUser,
} from './github.client';
import { GithubConfig } from './github-config';
import {
  type GithubIntent,
  OAUTH_TTL_MS,
  openOauthState,
  sealOauthState,
} from './oauth-cookie';

/** The `error` the callback redirects with; the web maps each to a message. */
export type GithubErrorCode =
  | 'github_no_verified_email'
  | 'github_link_requires_verified'
  | 'github_already_linked_elsewhere'
  | 'github_already_linked'
  | 'github_state_invalid'
  | 'github_denied'
  | 'github_failed';

export const UNLINK_REQUIRES_PASSWORD = 'github_unlink_requires_password';

const SCOPES = 'read:user user:email';

export class GithubAuthError extends Error {
  constructor(readonly code: GithubErrorCode) {
    super(code);
  }
}

export interface CallbackInput {
  code?: string;
  state?: string;
  error?: string;
}

export interface CallbackResult {
  /** Always a fixed path on the web origin, never taken from the request. */
  redirectTo: string;
  /** Set on a GitHub sign-in: the new session for the cookie. */
  session?: { token: string; expiresAt: Date };
}

/** GitHub OAuth sign-in and linking (spec #126, ADR-0006 rule 3). */
@Injectable()
export class GithubAuthService {
  private readonly logger = new Logger(GithubAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly github: GithubClient,
    private readonly config: GithubConfig,
    private readonly clock: Clock,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * The GitHub authorize URL and the sealed `df_oauth` value to set beside
   * it. `userId` is the signed-in user for a link, null for a sign-in.
   */
  start(
    intent: GithubIntent,
    userId: string | null,
  ): { url: string; cookie: string } {
    if (!this.config.enabled) {
      throw new NotFoundException();
    }
    const state = generateToken();
    const codeVerifier = generateToken();
    const cookie = sealOauthState(
      {
        state,
        codeVerifier,
        intent,
        userId,
        expiresAt: this.clock.now().getTime() + OAUTH_TTL_MS,
      },
      this.config.clientSecret,
    );

    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      allow_signup: 'true',
    }).toString();
    return { url: url.toString(), cookie };
  }

  /**
   * Finishes the flow. Every failure becomes an error redirect; the access
   * token lives only in this call and is never stored or logged.
   */
  async callback(
    input: CallbackInput,
    rawCookie: unknown,
    sessionUserId: string | null,
    userAgent: string | undefined,
  ): Promise<CallbackResult> {
    const web = this.config.webUrl;
    const sealed = this.config.enabled
      ? openOauthState(rawCookie, this.config.clientSecret, this.clock.now())
      : null;
    if (!sealed) {
      return { redirectTo: errorUrl(web, 'sign-in', 'github_state_invalid') };
    }
    const { intent } = sealed;

    try {
      if (!input.state || !sameString(input.state, sealed.state)) {
        throw new GithubAuthError('github_state_invalid');
      }
      if (input.error) {
        throw new GithubAuthError(
          input.error === 'access_denied' ? 'github_denied' : 'github_failed',
        );
      }
      if (!input.code) {
        throw new GithubAuthError('github_failed');
      }
      // A link finishes only in the session that started it.
      const linkUserId = sealed.userId;
      if (
        intent === 'link' &&
        (linkUserId === null || linkUserId !== sessionUserId)
      ) {
        throw new GithubAuthError('github_state_invalid');
      }

      const { user, emails } = await this.readGithub(
        input.code,
        sealed.codeVerifier,
        intent,
      );

      if (linkUserId !== null && intent === 'link') {
        await this.link(linkUserId, user);
        return { redirectTo: `${web}/app/settings` };
      }
      const signedIn = await this.resolveSignIn(user, emails);
      const session = await this.sessions.create(signedIn.id, userAgent);
      return { redirectTo: `${web}/app`, session };
    } catch (error) {
      if (error instanceof GithubAuthError) {
        return { redirectTo: errorUrl(web, intent, error.code) };
      }
      throw error;
    }
  }

  /**
   * The account a GitHub sign-in lands on — ADR-0006 rule 3, in this order:
   * 1. the identity already linked to this GitHub user id;
   * 2. no verified primary GitHub email: refused;
   * 3. a verified account with that email: linked;
   * 4. an unverified account with that email: refused;
   * 5. no account: created, verified, without a password.
   */
  async resolveSignIn(
    github: GithubUser,
    emails: GithubEmail[],
    retried = false,
  ): Promise<User> {
    const identity = await this.prisma.githubIdentity.findUnique({
      where: { githubUserId: github.id },
      include: { user: true },
    });
    if (identity) {
      if (identity.login !== github.login) {
        await this.prisma.githubIdentity.update({
          where: { id: identity.id },
          data: { login: github.login },
        });
      }
      return identity.user;
    }

    const primary = emails.find((e) => e.primary && e.verified);
    const email = primary ? normalizeEmail(primary.email) : null;
    if (typeof email !== 'string' || email === '') {
      throw new GithubAuthError('github_no_verified_email');
    }

    const existing = await this.prisma.user.findUnique({
      where: { email },
      include: { githubIdentity: true },
    });
    try {
      if (existing) {
        if (existing.emailVerifiedAt === null) {
          throw new GithubAuthError('github_link_requires_verified');
        }
        if (existing.githubIdentity) {
          // Verified, but already holds another GitHub account.
          throw new GithubAuthError('github_already_linked');
        }
        await this.prisma.githubIdentity.create({
          data: {
            userId: existing.id,
            githubUserId: github.id,
            login: github.login,
          },
        });
        return existing;
      }

      return await this.prisma.user.create({
        data: {
          email,
          emailVerifiedAt: this.clock.now(),
          githubIdentity: {
            create: { githubUserId: github.id, login: github.login },
          },
        },
      });
    } catch (error) {
      // A concurrent sign-in won the race; its result is the answer.
      if (isUniqueViolation(error) && !retried) {
        return this.resolveSignIn(github, emails, true);
      }
      if (isUniqueViolation(error)) {
        throw new GithubAuthError('github_failed');
      }
      throw error;
    }
  }

  /**
   * Links from settings: the person proved both identities in this session,
   * so no email has to match (spec #126, Decision 4).
   */
  async link(userId: string, github: GithubUser): Promise<void> {
    const owner = await this.prisma.githubIdentity.findUnique({
      where: { githubUserId: github.id },
    });
    if (owner) {
      if (owner.userId === userId) {
        return;
      }
      throw new GithubAuthError('github_already_linked_elsewhere');
    }
    const mine = await this.prisma.githubIdentity.findUnique({
      where: { userId },
    });
    if (mine) {
      throw new GithubAuthError('github_already_linked');
    }

    try {
      await this.prisma.githubIdentity.create({
        data: { userId, githubUserId: github.id, login: github.login },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced = await this.prisma.githubIdentity.findUnique({
        where: { githubUserId: github.id },
      });
      if (raced?.userId === userId) {
        return;
      }
      throw new GithubAuthError(
        raced ? 'github_already_linked_elsewhere' : 'github_already_linked',
      );
    }
  }

  /** A user without a password would be locked out, so they keep GitHub. */
  async unlink(user: User): Promise<void> {
    if (user.passwordHash === null) {
      throw new ConflictException(UNLINK_REQUIRES_PASSWORD);
    }
    await this.prisma.githubIdentity.deleteMany({ where: { userId: user.id } });
  }

  async isLinked(userId: string): Promise<boolean> {
    const identity = await this.prisma.githubIdentity.findUnique({
      where: { userId },
      select: { id: true },
    });
    return identity !== null;
  }

  /** The profile, and for a sign-in the emails. The token goes out of scope here. */
  private async readGithub(
    code: string,
    codeVerifier: string,
    intent: GithubIntent,
  ): Promise<{ user: GithubUser; emails: GithubEmail[] }> {
    try {
      const accessToken = await this.github.exchangeCode({
        code,
        codeVerifier,
        redirectUri: this.config.redirectUri,
      });
      const user = await this.github.getUser(accessToken);
      const emails =
        intent === 'sign-in' ? await this.github.getEmails(accessToken) : [];
      return { user, emails };
    } catch (error) {
      if (error instanceof GithubRequestError) {
        this.logger.warn(error.message);
        throw new GithubAuthError('github_failed');
      }
      throw error;
    }
  }
}

/** PKCE S256 (RFC 7636). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function errorUrl(
  web: string,
  intent: GithubIntent,
  code: GithubErrorCode,
): string {
  const path = intent === 'link' ? '/app/settings' : '/sign-in';
  return `${web}${path}?error=${code}`;
}

/** Constant-time: both sides are hashed to one length first. */
function sameString(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
