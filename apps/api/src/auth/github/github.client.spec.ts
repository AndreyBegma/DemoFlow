import { GithubRequestError, HttpGithubClient } from './github.client';
import type { GithubConfig } from './github-config';

const TOKEN = 'gho_must_never_leak';

function client(): HttpGithubClient {
  return new HttpGithubClient({
    clientId: 'id',
    clientSecret: 'secret',
  } as GithubConfig);
}

function respond(status: number, body: unknown): void {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('HttpGithubClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exchanges the code with the PKCE verifier and the fixed redirect', async () => {
    respond(200, { access_token: TOKEN, token_type: 'bearer' });
    const token = await client().exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://localhost:3670/api/auth/github/callback',
    });
    expect(token).toBe(TOKEN);
    const [url, init] = jest.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: 'id',
      client_secret: 'secret',
      code: 'c',
      redirect_uri: 'http://localhost:3670/api/auth/github/callback',
      code_verifier: 'v',
    });
  });

  it('treats a 200 with an error field as a refused exchange', async () => {
    respond(200, { error: 'bad_verification_code' });
    await expect(
      client().exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toThrow(GithubRequestError);
  });

  it('keeps the token out of every error message', async () => {
    for (const call of [
      () => client().getUser(TOKEN),
      () => client().getEmails(TOKEN),
    ]) {
      respond(401, { message: 'Bad credentials' });
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GithubRequestError);
      expect(String((error as Error).message)).not.toContain(TOKEN);
      jest.restoreAllMocks();
    }
  });

  it('reads the user id as a string and keeps only well-formed emails', async () => {
    respond(200, { id: 42, login: 'octo' });
    expect(await client().getUser(TOKEN)).toEqual({ id: '42', login: 'octo' });
    jest.restoreAllMocks();

    respond(200, [
      { email: 'a@example.test', primary: true, verified: true },
      { email: 'b@example.test', primary: false, verified: 'yes' },
      { primary: true },
    ]);
    expect(await client().getEmails(TOKEN)).toEqual([
      { email: 'a@example.test', primary: true, verified: true },
      { email: 'b@example.test', primary: false, verified: false },
    ]);
  });
});
