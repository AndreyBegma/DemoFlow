import type { HostEnvironment } from '../config/platform.ts';

/**
 * Login autostart (spec 151, Decision 2): a systemd user unit, a LaunchAgent
 * or a Task Scheduler task running `demoflow runner --foreground`. `status`
 * asks it whether one is installed. `runner install` / `uninstall` provide
 * the real implementation from `src/runner/install/`.
 */
export interface Autostart {
  installed(host: HostEnvironment): boolean;
}

/** Until `runner install` exists, nothing can be installed. */
export const noAutostart: Autostart = {
  installed: () => false,
};
