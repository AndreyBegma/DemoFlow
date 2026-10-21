import { cookies } from 'next/headers';
import { cache } from 'react';
import {
  type AccountUser,
  type DeviceRequest,
  getDeviceRequest,
  listRunners,
  me,
  type Providers,
  providers,
  type Runner,
} from './api';

function apiUrl(): string {
  return process.env.API_URL ?? 'http://localhost:8370';
}

/**
 * The signed-in user of the current request, or null for a guest. Calls the
 * API on its internal origin with the request's cookies; `me` carries no IP
 * limit, so every page may call it. Cached per request, so a layout and its
 * page share one call.
 */
export const getSessionUser = cache(async (): Promise<AccountUser | null> => {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  const result = await me({ baseUrl: apiUrl(), cookie });
  return result.ok ? result.data.user : null;
});

/** The signed-in user's paired machines, or null when the API fails. */
export async function getRunners(): Promise<Runner[] | null> {
  const cookie = (await cookies()).toString();
  const result = await listRunners({ baseUrl: apiUrl(), cookie });
  return result.ok ? result.data.runners : null;
}

/**
 * A pending device code: the request, `'not_found'` for an unknown, expired or
 * used code, or `'error'` when the API fails.
 */
export async function getDevice(
  code: string,
): Promise<DeviceRequest | 'not_found' | 'error'> {
  const cookie = (await cookies()).toString();
  const result = await getDeviceRequest(code, { baseUrl: apiUrl(), cookie });
  if (result.ok) return result.data;
  return result.status === 404 ? 'not_found' : 'error';
}

/**
 * The sign-in providers the API is configured for. An unreachable API reads
 * as "none": the GitHub button stays hidden rather than leading to a 404.
 */
export const getProviders = cache(async (): Promise<Providers> => {
  const result = await providers({ baseUrl: apiUrl() });
  return result.ok ? result.data : { github: false };
});
