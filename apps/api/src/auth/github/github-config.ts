import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The GitHub OAuth App credentials (spec #126, Decision 5). While either is
 * empty, GitHub sign-in is off: `start` is a 404 and the web hides the button.
 */
@Injectable()
export class GithubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The web origin: the callback and every redirect are fixed paths on it. */
  readonly webUrl: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('GITHUB_CLIENT_ID')?.trim() ?? '';
    this.clientSecret =
      config.get<string>('GITHUB_CLIENT_SECRET')?.trim() ?? '';
    this.webUrl = (
      config.get<string>('WEB_URL') ?? 'http://localhost:3670'
    ).replace(/\/+$/, '');
  }

  get enabled(): boolean {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  /**
   * Registered on the OAuth App. Reaches the API through `/api` — Caddy on
   * staging, the Next rewrite locally — so the cookies stay on the web origin.
   */
  get redirectUri(): string {
    return `${this.webUrl}/api/auth/github/callback`;
  }
}
