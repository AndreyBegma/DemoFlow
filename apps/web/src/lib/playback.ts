// Pure playback logic for the run page (spec #193). No React, no Node APIs, so
// `node --test` runs it as it is.

/** The formats the page offers, in the order it offers them. */
export const FORMAT_ORDER = [
  'mp4',
  'webm',
  'mp4-vertical',
  'webm-vertical',
  'gif',
  'gif-vertical',
] as const;

export type PlayableFormat = (typeof FORMAT_ORDER)[number];

export type Availability = 'removed' | 'offline' | 'failed' | 'ready';

/** The machine as `GET /runs/:id` reports it; null when it was removed. */
export interface MachineState {
  name: string;
  online: boolean;
}

/**
 * The run's formats the page can show, in display order. Unknown strings and
 * duplicates are dropped. The first one is the default.
 */
export function orderFormats(formats: readonly string[]): PlayableFormat[] {
  return FORMAT_ORDER.filter((format) => formats.includes(format));
}

/** The same-origin relay URL, so the session cookie goes with the request. */
export function videoUrl(runId: string, format: PlayableFormat): string {
  return `/api/runs/${encodeURIComponent(runId)}/video/${format}`;
}

export type DeleteFailureKey =
  | 'runPage.delete.errors.offline'
  | 'runPage.delete.errors.failed'
  | 'runPage.delete.errors.missing'
  | 'auth.errors.unknown';

/** The message for a failed `DELETE /runs/:id/artifacts` (spec #235, Decision 4). */
export function deleteFailureKey(code: string | undefined): DeleteFailureKey {
  switch (code) {
    case 'runner-offline':
    case 'runner-removed':
      return 'runPage.delete.errors.offline';
    case 'runner-timeout':
    case 'runner-error':
      return 'runPage.delete.errors.failed';
    case 'artifacts-missing':
      return 'runPage.delete.errors.missing';
    default:
      return 'auth.errors.unknown';
  }
}

/**
 * What the page shows for a run. A `<video>` exposes no HTTP status, so a
 * failure while the machine is online is told apart from an offline machine
 * by the run's `online` flag alone, refetched before this is called.
 */
export function availability(
  machine: MachineState | null,
  playerFailed: boolean,
): Availability {
  if (machine === null) return 'removed';
  if (!machine.online) return 'offline';
  return playerFailed ? 'failed' : 'ready';
}
