// One status vocabulary for every /app page (spec #374, Decision 2). Pure, so
// `node --test` runs it as it is: no React, no Node APIs, type imports only.

import type { LaunchState, ProjectRun, RunDetail, RunStageStatus } from './api';

/** The five kinds a page can show; the pill's tone follows the kind. */
export type StatusKind =
  | 'running'
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'idle';

/** The Glass UI `StatusPill` state each kind is drawn with. */
export const PILL_STATUS = {
  running: 'running',
  passed: 'done',
  failed: 'error',
  unavailable: 'paused',
  idle: 'idle',
} as const satisfies Record<StatusKind, string>;

export type StatusLabel =
  | 'status.passed'
  | 'status.failed'
  | 'status.neverRun'
  | 'status.starting'
  | 'status.running'
  | 'status.cancelling'
  | 'status.cancelled'
  | 'status.timedOut'
  | 'status.lost'
  | 'status.pending'
  | 'status.skipped'
  | 'status.filesDeleted'
  | 'status.noVideo'
  | 'status.machineRemoved'
  | 'status.offline'
  | 'status.online';

/** A kind and the dictionary key of its label: colour is never the only signal. */
export interface StatusView {
  kind: StatusKind;
  label: StatusLabel;
}

/** A finished run's own result. */
export function runStatus(status: ProjectRun['status']): StatusView {
  return status === 'passed'
    ? { kind: 'passed', label: 'status.passed' }
    : { kind: 'failed', label: 'status.failed' };
}

/** A project's last run; a project without one has never run. */
export function lastRunStatus(
  lastRun: Pick<ProjectRun, 'status'> | null,
): StatusView {
  return lastRun === null
    ? { kind: 'idle', label: 'status.neverRun' }
    : runStatus(lastRun.status);
}

const LAUNCH: Record<LaunchState, StatusView> = {
  starting: { kind: 'running', label: 'status.starting' },
  running: { kind: 'running', label: 'status.running' },
  cancelling: { kind: 'running', label: 'status.cancelling' },
  passed: { kind: 'passed', label: 'status.passed' },
  failed: { kind: 'failed', label: 'status.failed' },
  'timed-out': { kind: 'failed', label: 'status.timedOut' },
  cancelled: { kind: 'idle', label: 'status.cancelled' },
  lost: { kind: 'unavailable', label: 'status.lost' },
};

/** A run started from the website, while it goes and once it ends. */
export function launchStatus(state: LaunchState): StatusView {
  return LAUNCH[state];
}

const STAGE: Record<RunStageStatus, StatusView> = {
  pending: { kind: 'idle', label: 'status.pending' },
  running: { kind: 'running', label: 'status.running' },
  passed: { kind: 'passed', label: 'status.passed' },
  failed: { kind: 'failed', label: 'status.failed' },
  skipped: { kind: 'idle', label: 'status.skipped' },
};

/** One stage of a run's report. */
export function stageStatus(status: RunStageStatus): StatusView {
  return STAGE[status];
}

/**
 * A paired machine. Online uses the success tone, not `running`, which means a
 * run in progress (Decision 7); offline is `unavailable`.
 */
export function machineStatus(online: boolean): StatusView {
  return online
    ? { kind: 'passed', label: 'status.online' }
    : { kind: 'unavailable', label: 'status.offline' };
}

/** A project's or a run's machine that was removed from the account. */
export const MACHINE_REMOVED: StatusView = {
  kind: 'unavailable',
  label: 'status.machineRemoved',
};

/** A run whose files the machine deleted; null while they are there. */
export function artifactStatus(
  run: Pick<ProjectRun, 'artifactsDeletedAt'>,
): StatusView | null {
  return run.artifactsDeletedAt === null
    ? null
    : { kind: 'unavailable', label: 'status.filesDeleted' };
}

/**
 * Why a run's video cannot be played from the site, or null when it can: its
 * files were deleted, it rendered none, its machine was removed or is offline.
 */
export function videoStatus(
  run: Pick<ProjectRun, 'artifactsDeletedAt' | 'formats'>,
  machine: Pick<NonNullable<RunDetail['machine']>, 'online'> | null,
): StatusView | null {
  const artifacts = artifactStatus(run);
  if (artifacts) return artifacts;
  if (run.formats.length === 0)
    return { kind: 'idle', label: 'status.noVideo' };
  if (machine === null) return MACHINE_REMOVED;
  return machine.online ? null : machineStatus(false);
}
