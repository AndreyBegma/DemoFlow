// Typed client for the accounts API (spec #120). In the browser every call is
// same-origin `/api/…`; a server component passes the API's internal origin
// and the request's cookie header instead.

export type ApiError = 'invalid' | 'rate_limited' | 'unknown';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** What `me` returns: the user, and how they can sign in (spec #126). */
export interface AccountUser extends PublicUser {
  githubLinked: boolean;
  hasPassword: boolean;
}

/** The sign-in providers the API has credentials for. */
export interface Providers {
  github: boolean;
}

/**
 * Where the browser goes to sign in with, or link, GitHub. A navigation, not
 * a fetch: the API answers with a redirect to GitHub.
 */
export function githubStartUrl(intent: 'sign-in' | 'link'): string {
  return `/api/auth/github/start?intent=${intent}`;
}

interface Target {
  /** Origin to call instead of the same-origin `/api` prefix. */
  baseUrl?: string;
  /** The incoming request's `cookie` header, for server-side calls. */
  cookie?: string;
}

function errorFor(status: number): ApiError {
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid';
  return 'unknown';
}

async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
  target: Target = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (target.cookie) headers.cookie = target.cookie;
  try {
    const response = await fetch(`${target.baseUrl ?? '/api'}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return { ok: false, error: errorFor(response.status) };
    const text = await response.text();
    return { ok: true, data: (text ? JSON.parse(text) : undefined) as T };
  } catch {
    return { ok: false, error: 'unknown' };
  }
}

export function signUp(email: string, password: string) {
  return request<void>('/auth/sign-up', {
    method: 'POST',
    body: { email, password },
  });
}

export function signIn(email: string, password: string) {
  return request<{ user: PublicUser }>('/auth/sign-in', {
    method: 'POST',
    body: { email, password },
  });
}

export function signOut() {
  return request<void>('/auth/sign-out', { method: 'POST' });
}

export function me(target?: Target) {
  return request<{ user: AccountUser }>('/auth/me', { method: 'GET' }, target);
}

export function providers(target?: Target) {
  return request<Providers>('/auth/providers', { method: 'GET' }, target);
}

export function unlinkGithub() {
  return request<void>('/auth/github', { method: 'DELETE' });
}

export function verifyEmail(token: string) {
  return request<void>('/auth/verify-email', {
    method: 'POST',
    body: { token },
  });
}

export function resendVerification() {
  return request<void>('/auth/verify-email/resend', { method: 'POST' });
}

export function requestPasswordReset(email: string) {
  return request<void>('/auth/password-reset', {
    method: 'POST',
    body: { email },
  });
}

export function confirmPasswordReset(token: string, password: string) {
  return request<void>('/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, password },
  });
}
