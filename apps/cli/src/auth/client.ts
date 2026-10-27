import { apiBase } from './server.ts';

export type Fetch = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface MachineInfo {
  hostname: string;
  os: string;
  cliVersion: string;
}

export interface PairedRunner {
  token: string;
  runnerId: string;
  name: string;
  email: string;
}

export type PollResult =
  | { state: 'approved'; runner: PairedRunner }
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'denied' }
  | { state: 'expired' };

/** The server did not answer, or answered something the contract does not allow. */
export class ServerError extends Error {
  readonly unreachable: boolean;

  constructor(message: string, unreachable: boolean) {
    super(message);
    this.name = 'ServerError';
    this.unreachable = unreachable;
  }
}

/** POST /runner/device/code: starts a pairing. */
export async function requestDeviceCode(
  server: string,
  machine: MachineInfo,
  fetchFn: Fetch,
): Promise<DeviceCode> {
  const response = await send(fetchFn, server, '/runner/device/code', {
    method: 'POST',
    body: machine,
  });
  if (response.status !== 200) throw unexpected(response.status);
  const body = await readJson(response);
  const code = {
    deviceCode: field(body, 'deviceCode'),
    userCode: field(body, 'userCode'),
    verificationUri: field(body, 'verificationUri'),
    verificationUriComplete: field(body, 'verificationUriComplete'),
    expiresIn: numberField(body, 'expiresIn'),
    interval: numberField(body, 'interval'),
  };
  return code;
}

/** POST /runner/device/token: one poll (RFC 8628 §3.5). */
export async function pollDeviceToken(
  server: string,
  deviceCode: string,
  fetchFn: Fetch,
): Promise<PollResult> {
  const response = await send(fetchFn, server, '/runner/device/token', {
    method: 'POST',
    body: { deviceCode },
  });
  if (response.status === 200) {
    const body = await readJson(response);
    return {
      state: 'approved',
      runner: {
        token: field(body, 'token'),
        runnerId: field(body, 'runnerId'),
        name: field(body, 'name'),
        email: field(body, 'email'),
      },
    };
  }
  if (response.status === 400) {
    const error = (await readJson(response)).error;
    if (error === 'authorization_pending') return { state: 'pending' };
    if (error === 'slow_down') return { state: 'slow_down' };
    if (error === 'access_denied') return { state: 'denied' };
    if (error === 'expired_token') return { state: 'expired' };
  }
  throw unexpected(response.status);
}

/** GET /runner/self: who this token belongs to, or `null` when it is revoked. */
export async function fetchSelf(
  server: string,
  token: string,
  fetchFn: Fetch,
): Promise<{ runnerId: string; name: string; email: string } | null> {
  const response = await send(fetchFn, server, '/runner/self', {
    method: 'GET',
    token,
  });
  if (response.status === 401) return null;
  if (response.status !== 200) throw unexpected(response.status);
  const body = await readJson(response);
  return {
    runnerId: field(body, 'runnerId'),
    name: field(body, 'name'),
    email: field(body, 'email'),
  };
}

/** POST /runner/logout: revokes this token. A token already revoked counts as done. */
export async function revokeSelf(
  server: string,
  token: string,
  fetchFn: Fetch,
): Promise<void> {
  const response = await send(fetchFn, server, '/runner/logout', {
    method: 'POST',
    token,
  });
  if (response.status === 204 || response.status === 401) return;
  throw unexpected(response.status);
}

/** One request to the API, with the device token when given. */
export async function send(
  fetchFn: Fetch,
  server: string,
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; token?: string },
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    return await fetchFn(`${apiBase(server)}${path}`, {
      method: options.method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The cause can carry the request, so only the server is named.
    throw new ServerError(`cannot reach ${server}`, true);
  }
}

/** The JSON object a response carries, or a `ServerError`. */
export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ServerError('the server sent a response that is not JSON', false);
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value === '') {
    throw new ServerError(`the server response has no "${name}"`, false);
  }
  return value;
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ServerError(`the server response has no "${name}"`, false);
  }
  return value;
}

export function unexpected(status: number): ServerError {
  return new ServerError(`the server answered ${status}`, false);
}
