import { Injectable } from '@nestjs/common';
import { GithubConfig } from './github-config';

export interface GithubUser {
  /** GitHub's numeric user id, as a string. */
  id: string;
  login: string;
}

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Raised for any failed GitHub call. Its message names the step and the HTTP
 * status, never a code or a token, so it is safe to log.
 */
export class GithubRequestError extends Error {}

/**
 * Every GitHub HTTP call of the sign-in flow (spec #126). Tests replace it
 * with a fake, so no test reaches github.com.
 */
export abstract class GithubClient {
  /** Trades the authorization code for an access token. */
  abstract exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string>;

  abstract getUser(accessToken: string): Promise<GithubUser>;

  abstract getEmails(accessToken: string): Promise<GithubEmail[]>;
}

const TIMEOUT_MS = 10_000;
const API = 'https://api.github.com';

@Injectable()
export class HttpGithubClient extends GithubClient {
  constructor(private readonly config: GithubConfig) {
    super();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string> {
    const body = await this.call(
      'token exchange',
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      },
    );
    // GitHub answers a refused exchange with 200 and an `error` field.
    if (!isRecord(body) || typeof body.access_token !== 'string') {
      const error = isRecord(body) ? String(body.error ?? 'no token') : '';
      throw new GithubRequestError(`GitHub token exchange refused: ${error}`);
    }
    return body.access_token;
  }

  async getUser(accessToken: string): Promise<GithubUser> {
    const body = await this.call('user', `${API}/user`, {
      headers: apiHeaders(accessToken),
    });
    if (
      !isRecord(body) ||
      typeof body.id !== 'number' ||
      typeof body.login !== 'string'
    ) {
      throw new GithubRequestError('GitHub user: unexpected response');
    }
    return { id: String(body.id), login: body.login };
  }

  async getEmails(accessToken: string): Promise<GithubEmail[]> {
    const body = await this.call('emails', `${API}/user/emails`, {
      headers: apiHeaders(accessToken),
    });
    if (!Array.isArray(body)) {
      throw new GithubRequestError('GitHub emails: unexpected response');
    }
    return body.filter(isRecord).flatMap((entry) =>
      typeof entry.email === 'string'
        ? [
            {
              email: entry.email,
              primary: entry.primary === true,
              verified: entry.verified === true,
            },
          ]
        : [],
    );
  }

  private async call(
    step: string,
    url: string,
    init: RequestInit,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new GithubRequestError(`GitHub ${step}: ${reason}`);
    }
    if (!response.ok) {
      throw new GithubRequestError(`GitHub ${step}: HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new GithubRequestError(`GitHub ${step}: invalid JSON`);
    }
  }
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'DemoFlow',
    'x-github-api-version': '2022-11-28',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
