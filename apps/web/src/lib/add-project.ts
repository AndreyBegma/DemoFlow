// Rules of the Add project dialog (spec #379). Plain functions and a reducer,
// so they are unit-tested without a browser.

/** What the machine found in a folder (spec #377, Decision 5). */
export interface FolderInspection {
  rootPath: string;
  name: string;
  hasConfig: boolean;
  configValid: boolean;
  scenarios: { id: string; name: string }[];
  githubUrl: string | null;
}

/** The pause after the last keystroke before the folder is inspected (Decision 3). */
export const INSPECT_DELAY_MS = 600;

/** How many scenario names the inspection shows. */
export const SCENARIOS_SHOWN = 5;

export const PROJECT_NAME_MAX = 200;

/** The API's pattern for a project's GitHub link (spec #378, Decision 1). */
export const GITHUB_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// Machines.

export type MachineChoice = 'ready' | 'offline' | 'outdated';

/**
 * Whether a machine can be chosen (Decision 2): online, and announcing
 * `projects`. An API older than spec #378 sends no `features`: outdated.
 */
export function machineChoice(machine: {
  online: boolean;
  features?: readonly string[];
}): MachineChoice {
  if (!machine.online) return 'offline';
  return machine.features?.includes('projects') ? 'ready' : 'outdated';
}

/**
 * The machine chosen when the dialog opens: the one that reported the latest
 * run when it can be chosen, else the first that can, else none.
 */
export function preselectMachine(
  machines: readonly {
    id: string;
    online: boolean;
    features?: readonly string[];
  }[],
  projects: readonly {
    runner: { id: string } | null;
    lastRun: { startedAt: string } | null;
  }[],
): string {
  const ready = machines.filter(
    (machine) => machineChoice(machine) === 'ready',
  );
  let latest: { runnerId: string; at: number } | null = null;
  for (const project of projects) {
    if (!project.runner || !project.lastRun) continue;
    const at = Date.parse(project.lastRun.startedAt);
    if (latest === null || at > latest.at) {
      latest = { runnerId: project.runner.id, at };
    }
  }
  const last = ready.find((machine) => machine.id === latest?.runnerId);
  return (last ?? ready[0])?.id ?? '';
}

/**
 * The path placeholder in the machine's platform style (Decision 4), from the
 * `os` its CLI reported at pairing (`win32 10.0…`, `darwin 24…`, `linux 6…`).
 */
export function pathPlaceholder(os: string | undefined): string {
  if (os?.startsWith('win32')) return 'C:\\Users\\you\\my-app';
  if (os?.startsWith('darwin')) return '/Users/you/my-app';
  return '/home/you/my-app';
}

// What the inspection means.

export type InspectionResult = 'found' | 'no-config' | 'config-invalid';

export function inspectionResult(
  inspection: FolderInspection,
): InspectionResult {
  if (!inspection.hasConfig) return 'no-config';
  return inspection.configValid ? 'found' : 'config-invalid';
}

export type FolderErrorKey =
  | 'projects.add.errors.pathNotAllowed'
  | 'projects.add.errors.configMissing'
  | 'projects.add.errors.configInvalid'
  | 'projects.add.errors.runnerNotFound'
  | 'projects.add.errors.runnerOffline'
  | 'projects.add.errors.runnerOutdated'
  | 'projects.add.errors.runnerBusy'
  | 'projects.add.errors.runnerTimeout'
  | 'projects.add.errors.runnerError'
  | 'projects.add.errors.projectExists'
  | 'projects.add.errors.invalid'
  | 'auth.errors.rateLimited'
  | 'auth.errors.unknown';

/** The message for a failed folder call, from its `{ error }` code. */
export function folderErrorKey(failure: {
  error: string;
  code?: string;
}): FolderErrorKey {
  switch (failure.code) {
    case 'path-not-allowed':
      return 'projects.add.errors.pathNotAllowed';
    case 'config-missing':
      return 'projects.add.errors.configMissing';
    case 'config-invalid':
      return 'projects.add.errors.configInvalid';
    case 'runner-not-found':
      return 'projects.add.errors.runnerNotFound';
    case 'runner-offline':
      return 'projects.add.errors.runnerOffline';
    case 'runner-outdated':
      return 'projects.add.errors.runnerOutdated';
    case 'runner-busy':
      return 'projects.add.errors.runnerBusy';
    case 'runner-timeout':
      return 'projects.add.errors.runnerTimeout';
    case 'runner-error':
      return 'projects.add.errors.runnerError';
    case 'project-exists':
      return 'projects.add.errors.projectExists';
  }
  if (failure.error === 'rate_limited') return 'auth.errors.rateLimited';
  if (failure.error === 'invalid') return 'projects.add.errors.invalid';
  return 'auth.errors.unknown';
}

/** A typed GitHub link: empty is none, anything else must be a repository page. */
export function githubUrlValue(
  value: string,
): { ok: true; url: string | null } | { ok: false } {
  const url = value.trim();
  if (url === '') return { ok: true, url: null };
  return GITHUB_URL_PATTERN.test(url) ? { ok: true, url } : { ok: false };
}

export function isProjectName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && [...name].length <= PROJECT_NAME_MAX;
}

// The flow (Decision 3).

/**
 * `idle → inspecting → inspected | failed → (initialising → inspected) →
 * registering → done`, and back to `inspected` with an error when a step
 * fails. `seq` numbers the folder the dialog asks about: every machine or path
 * change takes a new one, and an answer for another number is stale.
 */
export type AddProjectState =
  | { phase: 'idle'; seq: number }
  | { phase: 'inspecting'; seq: number }
  | { phase: 'failed'; seq: number; error: FolderErrorKey }
  | {
      phase: 'inspected' | 'initialising' | 'registering';
      seq: number;
      inspection: FolderInspection;
      /** Files the dialog's Create config wrote, to say so. */
      created: string[] | null;
      error: FolderErrorKey | null;
      /** With `project-exists`: the project that holds the folder. */
      existingId: string | null;
    }
  | { phase: 'done'; seq: number; projectId: string };

export type AddProjectEvent =
  /** A new machine or path; `ready` when both are set and it is inspected next. */
  | { type: 'changed'; seq: number; ready: boolean }
  | { type: 'inspected'; seq: number; inspection: FolderInspection }
  | { type: 'inspect-failed'; seq: number; error: FolderErrorKey }
  | { type: 'init-started'; seq: number }
  | {
      type: 'initialised';
      seq: number;
      created: string[];
      inspection: FolderInspection;
    }
  | { type: 'init-failed'; seq: number; error: FolderErrorKey }
  | { type: 'register-started'; seq: number }
  | { type: 'registered'; seq: number; projectId: string }
  | {
      type: 'register-failed';
      seq: number;
      error: FolderErrorKey;
      existingId?: string | null;
    };

export const INITIAL_STATE: AddProjectState = { phase: 'idle', seq: 0 };

export function addProjectReducer(
  state: AddProjectState,
  event: AddProjectEvent,
): AddProjectState {
  if (event.type === 'changed') {
    if (event.seq <= state.seq || state.phase === 'done') return state;
    return { phase: event.ready ? 'inspecting' : 'idle', seq: event.seq };
  }
  // Every other event answers a folder: only the current one counts.
  if (event.seq !== state.seq) return state;
  switch (event.type) {
    case 'inspected':
      if (state.phase !== 'inspecting') return state;
      return found(state.seq, event.inspection, null);
    case 'inspect-failed':
      if (state.phase !== 'inspecting') return state;
      return { phase: 'failed', seq: state.seq, error: event.error };
    case 'init-started':
      if (
        state.phase !== 'inspected' ||
        inspectionResult(state.inspection) !== 'no-config'
      ) {
        return state;
      }
      return { ...state, phase: 'initialising', error: null };
    case 'initialised':
      if (state.phase !== 'initialising') return state;
      return found(state.seq, event.inspection, event.created);
    case 'init-failed':
      if (state.phase !== 'initialising') return state;
      return { ...state, phase: 'inspected', error: event.error };
    case 'register-started':
      if (
        state.phase !== 'inspected' ||
        inspectionResult(state.inspection) !== 'found'
      ) {
        return state;
      }
      return { ...state, phase: 'registering', error: null, existingId: null };
    case 'registered':
      if (state.phase !== 'registering') return state;
      return { phase: 'done', seq: state.seq, projectId: event.projectId };
    case 'register-failed':
      if (state.phase !== 'registering') return state;
      return {
        ...state,
        phase: 'inspected',
        error: event.error,
        existingId: event.existingId ?? null,
      };
  }
}

function found(
  seq: number,
  inspection: FolderInspection,
  created: string[] | null,
): AddProjectState {
  return {
    phase: 'inspected',
    seq,
    inspection,
    created,
    error: null,
    existingId: null,
  };
}

/** Add project is offered only for a folder with a valid config. */
export function canAdd(state: AddProjectState): boolean {
  return (
    state.phase === 'inspected' &&
    inspectionResult(state.inspection) === 'found'
  );
}

/** Create config is offered only for a folder without one. */
export function canCreateConfig(state: AddProjectState): boolean {
  return (
    state.phase === 'inspected' &&
    inspectionResult(state.inspection) === 'no-config'
  );
}

// The debounce.

interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * Inspects the folder once typing pauses for `delayMs` (Decision 3). Every
 * `change` cancels the pending inspection; one already sent answers with its
 * own `seq`, which the reducer drops as stale.
 */
export function createInspector(options: {
  inspect: (seq: number) => Promise<void>;
  delayMs?: number;
  timers?: Timers;
}): { change: (seq: number, ready: boolean) => void; dispose: () => void } {
  const timers: Timers = options.timers ?? {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const delayMs = options.delayMs ?? INSPECT_DELAY_MS;
  let pending: unknown = null;

  function cancel() {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  }

  return {
    change(seq, ready) {
      cancel();
      if (!ready) return;
      pending = timers.setTimeout(() => {
        pending = null;
        void options.inspect(seq);
      }, delayMs);
    },
    dispose: cancel,
  };
}
