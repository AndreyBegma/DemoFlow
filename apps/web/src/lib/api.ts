// Typed client for the accounts API (spec #120). In the browser every call is
// same-origin `/api/…`; a server component passes the API's internal origin
// and the request's cookie header instead.

export type ApiError = 'invalid' | 'rate_limited' | 'unknown';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError; status?: number };

/** A pending device code, as the signed-in user sees it (spec #135). */
export interface DeviceRequest {
  userCode: string;
  hostname: string;
  os: string;
  cliVersion: string;
  createdAt: string;
}

/** A paired machine (spec #135). */
export interface Runner {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Has an open socket right now (spec #151). */
  online: boolean;
  /** The last frame heard from the daemon. */
  lastSeenAt: string | null;
  /** The client IP at connect; shown only to the owner. */
  lastSeenIp: string | null;
}

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
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
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
    if (!response.ok) {
      return {
        ok: false,
        error: errorFor(response.status),
        status: response.status,
      };
    }
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

// Runner pairing (spec #135).

export function getDeviceRequest(userCode: string, target?: Target) {
  return request<DeviceRequest>(
    `/runner/device/${encodeURIComponent(userCode)}`,
    { method: 'GET' },
    target,
  );
}

export function approveDevice(userCode: string, name: string) {
  return request<void>(
    `/runner/device/${encodeURIComponent(userCode)}/approve`,
    { method: 'POST', body: { name } },
  );
}

export function denyDevice(userCode: string) {
  return request<void>(`/runner/device/${encodeURIComponent(userCode)}/deny`, {
    method: 'POST',
  });
}

export function listRunners(target?: Target) {
  return request<{ runners: Runner[] }>('/runners', { method: 'GET' }, target);
}

export function renameRunner(id: string, name: string) {
  return request<{ runner: Runner }>(`/runners/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
  });
}

/** Deletes the signed-in account at once (spec #177); `email` confirms it. */
export function deleteAccount(email: string) {
  return request<void>('/me', { method: 'DELETE', body: { email } });
}

export function revokeRunner(id: string) {
  return request<void>(`/runners/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// Projects and the run library (spec #178).

/** A run's metadata; videos stay on the machine (ADR-0008). */
export interface ProjectRun {
  id: string;
  scenarioName: string;
  scenarioPath: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  formats: string[];
  failedStep: number | null;
  cliVersion: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string | null;
  /** Null for a project never bound, or whose machine was revoked. */
  runner: { id: string; name: string } | null;
  runCount: number;
  lastRun: ProjectRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRunsPage {
  runs: ProjectRun[];
  nextCursor: string | null;
}

export function listProjects(target?: Target) {
  return request<{ projects: Project[] }>(
    '/projects',
    { method: 'GET' },
    target,
  );
}

export function createProject(name: string) {
  return request<{ project: Project }>('/projects', {
    method: 'POST',
    body: { name },
  });
}

/** Renames and binds; `runnerId` and `rootPath` come together or not at all. */
export function updateProject(
  id: string,
  changes: { name?: string; runnerId?: string; rootPath?: string },
) {
  return request<{ project: Project }>(`/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: changes,
  });
}

export function deleteProject(id: string) {
  return request<void>(`/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function listProjectRuns(id: string, cursor?: string, target?: Target) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request<ProjectRunsPage>(
    `/projects/${encodeURIComponent(id)}/runs${query}`,
    { method: 'GET' },
    target,
  );
}
