// Rules for the "Run a scenario" card (spec #249). Plain functions, so they
// are unit-tested without a browser.

/** The states in which the machine is still working on the launch. */
const ACTIVE_STATES = ['starting', 'running', 'cancelling'] as const;

/** Whether the launch is still going, so the card polls and locks the picker. */
export function isActive(state: string): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(state);
}

export type LaunchErrorKey =
  | 'projects.launch.errors.runnerOffline'
  | 'projects.launch.errors.runnerRemoved'
  | 'projects.launch.errors.projectUnbound'
  | 'projects.launch.errors.projectUnknown'
  | 'projects.launch.errors.runnerBusy'
  | 'projects.launch.errors.reportingOff'
  | 'projects.launch.errors.scenarioNotFound'
  | 'projects.launch.errors.scenarioInvalid'
  | 'projects.launch.errors.configInvalid'
  | 'projects.launch.errors.runnerTimeout'
  | 'projects.launch.errors.runnerError'
  | 'auth.errors.unknown';

/** The message for an API error code from any of the launch calls. */
export function launchErrorKey(code: string | undefined): LaunchErrorKey {
  switch (code) {
    case 'runner-offline':
      return 'projects.launch.errors.runnerOffline';
    case 'runner-removed':
      return 'projects.launch.errors.runnerRemoved';
    case 'project-unbound':
      return 'projects.launch.errors.projectUnbound';
    case 'project-unknown':
      return 'projects.launch.errors.projectUnknown';
    case 'runner-busy':
      return 'projects.launch.errors.runnerBusy';
    case 'reporting-off':
      return 'projects.launch.errors.reportingOff';
    case 'scenario-not-found':
      return 'projects.launch.errors.scenarioNotFound';
    case 'scenario-invalid':
      return 'projects.launch.errors.scenarioInvalid';
    case 'config-invalid':
      return 'projects.launch.errors.configInvalid';
    case 'runner-timeout':
      return 'projects.launch.errors.runnerTimeout';
    case 'runner-error':
      return 'projects.launch.errors.runnerError';
    default:
      return 'auth.errors.unknown';
  }
}

/** 0:07, 12:03: the time a launch has been active. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  return `${Math.floor(total / 60)}:${seconds}`;
}
