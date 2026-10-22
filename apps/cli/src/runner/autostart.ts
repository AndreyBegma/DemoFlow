import type { HostEnvironment } from '../config/platform.ts';
import type { DaemonCommand } from './install/units.ts';

/** What `install` leaves to report besides success. */
export interface InstallResult {
  /** The runner was started as part of installing. */
  started: boolean;
  /** Non-fatal problems, e.g. the task was registered but could not be started. */
  warnings: string[];
}

export interface UninstallResult {
  /** `false` when nothing was installed. */
  removed: boolean;
  warnings: string[];
}

/**
 * Login autostart (spec 151, Decision 2): a systemd user unit, a LaunchAgent
 * or a Task Scheduler task running `demoflow runner --foreground`. `status`
 * asks it whether one is installed; `runner install` / `uninstall` drive the
 * rest. The real implementation is `platformAutostart` in `install/autostart.ts`.
 */
export interface Autostart {
  installed(host: HostEnvironment): boolean;
  /** Registers autostart and starts the runner. Throws when it cannot register. */
  install(host: HostEnvironment, daemon: DaemonCommand): InstallResult;
  uninstall(host: HostEnvironment): UninstallResult;
}

/** An autostart that is never installed, for tests that do not care. */
export const noAutostart: Autostart = {
  installed: () => false,
  install: () => ({ started: false, warnings: [] }),
  uninstall: () => ({ removed: false, warnings: [] }),
};
