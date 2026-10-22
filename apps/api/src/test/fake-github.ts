import type { ConfigService } from '@nestjs/config';
import {
  GithubClient,
  type GithubEmail,
  GithubRequestError,
  type GithubUser,
} from '../auth/github/github.client';
import { GithubConfig } from '../auth/github/github-config';

export interface FakeAccount {
  code: string;
  token: string;
  user: GithubUser;
  emails: GithubEmail[];
}

/** GitHub, in memory. Each account answers one authorization code. */
export class FakeGithub extends GithubClient {
  private readonly byCode = new Map<string, FakeAccount>();
  private readonly byToken = new Map<string, FakeAccount>();
  readonly exchanges: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }[] = [];
  failEmails = false;
  private sequence = 0;

  /** A GitHub account; `email` is its primary address, verified unless said. */
  account(options: {
    email?: string;
    verified?: boolean;
    emails?: GithubEmail[];
  }): FakeAccount {
    this.sequence += 1;
    const n = `${process.pid}-${Date.now()}-${this.sequence}`;
    const account: FakeAccount = {
      code: `code-${n}`,
      token: `gho_secret_token_${n}`,
      user: { id: `9${n.replace(/\D/g, '')}`, login: `octo-${n}` },
      emails:
        options.emails ??
        (options.email
          ? [
              {
                email: options.email,
                primary: true,
                verified: options.verified ?? true,
              },
            ]
          : []),
    };
    this.register(account);
    return account;
  }

  /** The same GitHub user coming back with a new code (and maybe new emails). */
  again(account: FakeAccount, emails = account.emails): FakeAccount {
    this.sequence += 1;
    const next: FakeAccount = {
      ...account,
      code: `${account.code}-again-${this.sequence}`,
      token: `${account.token}-again-${this.sequence}`,
      emails,
    };
    this.register(next);
    return next;
  }

  private register(account: FakeAccount): void {
    this.byCode.set(account.code, account);
    this.byToken.set(account.token, account);
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string> {
    this.exchanges.push(input);
    const account = this.byCode.get(input.code);
    if (!account) {
      throw new GithubRequestError('GitHub token exchange refused: bad code');
    }
    return account.token;
  }

  async getUser(accessToken: string): Promise<GithubUser> {
    return this.of(accessToken).user;
  }

  async getEmails(accessToken: string): Promise<GithubEmail[]> {
    if (this.failEmails) {
      throw new GithubRequestError('GitHub emails: HTTP 502');
    }
    return this.of(accessToken).emails;
  }

  private of(accessToken: string): FakeAccount {
    const account = this.byToken.get(accessToken);
    if (!account) {
      throw new GithubRequestError('GitHub user: HTTP 401');
    }
    return account;
  }
}

/** The real `GithubConfig`, read from these values instead of the environment. */
export function fakeGithubConfig(
  clientId: string,
  clientSecret: string,
  webUrl: string,
): GithubConfig {
  const values: Record<string, string> = {
    GITHUB_CLIENT_ID: clientId,
    GITHUB_CLIENT_SECRET: clientSecret,
    WEB_URL: webUrl,
  };
  const config = { get: (key: string) => values[key] };
  return new GithubConfig(config as unknown as ConfigService);
}
