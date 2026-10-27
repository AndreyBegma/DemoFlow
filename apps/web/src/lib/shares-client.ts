// The owner's share calls (spec #350, API from spec #347). Kept out of
// `api.ts` so other Phase 8 slices do not collide there; the pure helpers and
// types are in `shares.ts`.

import { request, type Target } from './api';
import type { Share, ShareLifetime, SharesList } from './shares';

export function listShares(target?: Target) {
  return request<SharesList>('/shares', { method: 'GET' }, target);
}

/** 202: the row exists, the upload runs in the background. */
export function createShare(body: {
  runId: string;
  format: string;
  expiresInDays: ShareLifetime;
  password?: string;
}) {
  return request<Share>('/shares', { method: 'POST', body });
}

export function getShare(id: string) {
  return request<Share>(`/shares/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
}

/** 30 more days, never beyond 90 from now; `at-max-expiry` past the cap. */
export function extendShare(id: string) {
  return request<Share>(`/shares/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
  });
}

/** The link stops working at once; 204 when it is gone. */
export function revokeShare(id: string) {
  return request<void>(`/shares/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
