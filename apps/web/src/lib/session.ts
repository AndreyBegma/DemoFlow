import { cookies } from 'next/headers';
import { cache } from 'react';
import { me, type PublicUser } from './api';

/**
 * The signed-in user of the current request, or null for a guest. Calls the
 * API on its internal origin with the request's cookies; `me` carries no IP
 * limit, so every page may call it. Cached per request, so a layout and its
 * page share one call.
 */
export const getSessionUser = cache(async (): Promise<PublicUser | null> => {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  const result = await me({
    baseUrl: process.env.API_URL ?? 'http://localhost:8370',
    cookie,
  });
  return result.ok ? result.data.user : null;
});
