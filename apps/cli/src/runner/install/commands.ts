import { readCredentials } from '../../auth/credentials.ts';
import type { Io } from '../../commands/io.ts';
import type { ControlDeps } from '../control.ts';
import { redact } from '../log.ts';
import { runnerPaths } from '../paths.ts';
import { hasScheduledRoot } from '../schedule/roots.ts';

/**
 * `demoflow runner install`: registers login autostart for this user. The
 * unit runs the `node` and CLI path that ran this command, as absolute paths,
 * and carries no token — the daemon reads `credentials.json` itself.
 */
export function installCommand(io: Io, deps: ControlDeps): number {
  // Spec 361, Decision 5: a scheduled root runs without an account.
  if (
    readCredentials(deps.host) === null &&
    !hasScheduledRoot(runnerPaths(deps.host), deps.host.env)
  ) {
    io.stderr('Not logged in; run demoflow login first\n');
    return 1;
  }
  try {
    const result = deps.autostart.install(deps.host, deps.daemon);
    io.stdout(
      result.started
        ? 'Autostart installed; runner started\n'
        : 'Autostart installed; the runner starts at your next login\n',
    );
    for (const warning of result.warnings) {
      io.stderr(`${redact(`warning: ${warning}`)}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(
      `${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 1;
  }
}

/** `demoflow runner uninstall`: removes autostart. A running runner is left running; `runner stop` ends it. */
export function uninstallCommand(io: Io, deps: ControlDeps): number {
  try {
    const result = deps.autostart.uninstall(deps.host);
    io.stdout(
      result.removed ? 'Autostart removed\n' : 'Autostart is not installed\n',
    );
    for (const warning of result.warnings) {
      io.stderr(`${redact(`warning: ${warning}`)}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(
      `${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 1;
  }
}
