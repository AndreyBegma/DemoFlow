// Typed client for the accounts API (spec #120). In the browser every call is
// same-origin `/api/…`; a server component passes the API's internal origin
// and the request's cookie header instead.

export type ApiError = 'invalid' | 'rate_limited' | 'unknown';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError; status?: number; code?: string };

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

export interface Target {
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

/** The `{ error }` code of a failed response, when its body has one. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return typeof body.error === 'string' ? body.error : undefined;
    }
  } catch {
    // No JSON body: the status alone has to do.
  }
  return undefined;
}

export async function request<T>(
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
  },
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
        code: await errorCode(response),
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
  /** When the machine deleted the run's files (spec #233); null while present. */
  artifactsDeletedAt: string | null;
  /** `check` for a check run, which records no video (spec 360); absent or null otherwise. */
  kind?: 'check' | null;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string | null;
  /** Null for a project never bound, or whose machine was revoked. */
  runner: { id: string; name: string } | null;
  runCount: number;
  /** Scenarios whose latest run failed (spec #362); absent on an older API. */
  staleCount?: number;
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

// The run page (spec #193, API contract from spec #191 Decision 9).

/** One run with its project and the machine that recorded it. */
export type RunStageName =
  | 'readiness'
  | 'execution'
  | 'verification'
  | 'recording'
  | 'rendering'
  | 'storage';

export type RunStageStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

export interface RunRender {
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationMs: number;
}

/** The run's stage statuses, files and failure; null when the CLI did not report them (spec #263). */
export interface RunDetailView extends ProjectRun {
  stages: Record<RunStageName, RunStageStatus> | null;
  renders: RunRender[] | null;
  failure: { stage: RunStageName; message: string } | null;
}

export interface RunDetail {
  run: RunDetailView;
  project: { id: string; name: string };
  /** Null when the machine was removed. */
  machine: {
    id: string;
    name: string;
    online: boolean;
    /** What the machine accepts on a start; absent on an older API. */
    runOptions?: string[];
    /** What its daemon announced, as `share` (spec #347); absent on an older API. */
    features?: string[];
  } | null;
}

export function getRun(id: string, target?: Target) {
  return request<RunDetail>(
    `/runs/${encodeURIComponent(id)}`,
    { method: 'GET' },
    target,
  );
}

/** Asks the run's machine to delete its files; 204 when they are gone (spec #233). */
export function deleteRunArtifacts(id: string) {
  return request<void>(`/runs/${encodeURIComponent(id)}/artifacts`, {
    method: 'DELETE',
  });
}

/** Deletes the run's row; 204 when it is gone. The machine's files stay (spec #280). */
export function deleteRun(id: string) {
  return request<void>(`/runs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Deletes the project's runs among `runIds`; answers how many it removed (spec #286). */
export function deleteProjectRuns(projectId: string, runIds: string[]) {
  return request<{ deleted: number }>(
    `/projects/${encodeURIComponent(projectId)}/runs/delete`,
    { method: 'POST', body: { runIds } },
  );
}

// Starting a run from the website (spec #249, contract from spec #247).

/** A scenario file on the project's machine. */
export interface ScenarioEntry {
  id: string;
  name: string;
}

export interface ScenarioList {
  scenarios: ScenarioEntry[];
  /** More valid scenarios exist than were sent. */
  truncated: boolean;
  /** `*.demo.json` files that could not be read as scenarios. */
  skipped: number;
  /** What the machine accepts on a start; absent on an API older than #325. */
  runOptions?: string[];
}

export type LaunchState =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'lost';

export type LaunchPhase = 'app' | 'steps' | 'rendering';

/** Where a running launch is; absent or null on an older API or runner. */
export interface LaunchProgress {
  phase: LaunchPhase;
  step: number | null;
  steps: number | null;
}

/** The project's latest website-started run, held in memory by the API. */
export interface LaunchView {
  id: string;
  scenarioId: string;
  scenarioName: string | null;
  state: LaunchState;
  startedAt: string;
  finishedAt: string | null;
  runId: string | null;
  progress?: LaunchProgress | null;
  /** The formats the start asked for; null for the project's own. */
  formats?: string[] | null;
}

export function listScenarios(projectId: string) {
  return request<ScenarioList>(
    `/projects/${encodeURIComponent(projectId)}/scenarios`,
    { method: 'GET' },
  );
}

/**
 * Sends the scenario id and, only when given, the output formats (ADR-0017);
 * the machine owns everything else.
 */
export function startLaunch(
  projectId: string,
  scenarioId: string,
  formats?: string[],
) {
  return request<{ launch: LaunchView }>(
    `/projects/${encodeURIComponent(projectId)}/launch`,
    {
      method: 'POST',
      body: formats ? { scenarioId, formats } : { scenarioId },
    },
  );
}

export function getLaunch(projectId: string) {
  return request<{ launch: LaunchView | null }>(
    `/projects/${encodeURIComponent(projectId)}/launch`,
    { method: 'GET' },
  );
}

export function cancelLaunch(projectId: string) {
  return request<{ launch: LaunchView }>(
    `/projects/${encodeURIComponent(projectId)}/launch`,
    { method: 'DELETE' },
  );
}

// Check schedules and the stale state (spec #363, contract from spec #362).

export type ScheduleCadence = 'daily' | 'weekdays' | 'weekly';

/** A project's schedule, set on the website (`site`) or in its config. */
export interface CheckSchedule {
  source: 'site' | 'config';
  cadence: ScheduleCadence;
  /** `mon`…`sun`; set only for `weekly`. */
  weekday: string | null;
  /** `HH:MM`, 24-hour, in `timeZone`. */
  at: string;
  timeZone: string;
  exclude: string[];
  /** `config-schedule`, `no-machine` or `cli-too-old`; null while it runs. */
  pausedReason: string | null;
  /** Null while paused. */
  nextDueAt: string | null;
  lastPassAt: string | null;
}

export interface ProjectSchedules {
  site: CheckSchedule | null;
  config: CheckSchedule | null;
  machine: {
    id: string;
    name: string;
    online: boolean;
    /** The machine's own zone, once it has reported one. */
    zone: string | null;
  } | null;
}

/** What `PUT /projects/:id/schedule` takes. */
export interface ScheduleBody {
  cadence: ScheduleCadence;
  weekday?: string;
  at: string;
  timeZone: string;
  exclude: string[];
}

/** One scenario's state: `failed` is stale. */
export interface ScenarioHealth {
  scenarioPath: string;
  scenarioName: string;
  state: 'passed' | 'failed';
  since: string;
  lastRunId: string;
}

export interface StaleScenario {
  projectId: string;
  projectName: string;
  scenarioPath: string;
  scenarioName: string;
  since: string;
  lastRunId: string;
}

export function getSchedule(projectId: string, target?: Target) {
  return request<ProjectSchedules>(
    `/projects/${encodeURIComponent(projectId)}/schedule`,
    { method: 'GET' },
    target,
  );
}

export function putSchedule(projectId: string, body: ScheduleBody) {
  return request<CheckSchedule>(
    `/projects/${encodeURIComponent(projectId)}/schedule`,
    { method: 'PUT', body },
  );
}

export function deleteSchedule(projectId: string) {
  return request<void>(`/projects/${encodeURIComponent(projectId)}/schedule`, {
    method: 'DELETE',
  });
}

export function getHealth(projectId: string, target?: Target) {
  return request<ScenarioHealth[]>(
    `/projects/${encodeURIComponent(projectId)}/health`,
    { method: 'GET' },
    target,
  );
}

export function listStale(target?: Target) {
  return request<StaleScenario[]>('/checks/stale', { method: 'GET' }, target);
}

export type RunStatusFilter = ProjectRun['status'];

export function listProjectRuns(
  id: string,
  cursor?: string,
  target?: Target,
  status?: RunStatusFilter,
) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (status) params.set('status', status);
  const query = params.size > 0 ? `?${params}` : '';
  return request<ProjectRunsPage>(
    `/projects/${encodeURIComponent(id)}/runs${query}`,
    { method: 'GET' },
    target,
  );
}
