import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostEnvironment } from '../../config/platform.ts';
import { pathFor } from '../../config/platform.ts';
import type {
  Autostart,
  InstallResult,
  UninstallResult,
} from '../autostart.ts';
import {
  autostartFile,
  type DaemonCommand,
  DEFAULT_TASK_NAME,
  LAUNCHD_LABEL,
  launchdPlist,
  SYSTEMD_UNIT,
  systemdUnit,
  windowsTaskXml,
  windowsUser,
} from './units.ts';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs `systemctl`, `launchctl` or `schtasks`; a seam so tests can record the call. */
export type Exec = (command: string, args: string[]) => ExecResult;

export const spawnExec: Exec = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

export interface AutostartOptions {
  exec?: Exec;
  /** The Task Scheduler task name; tests use a unique one. */
  taskName?: string;
  /** The numeric user id launchd's `gui/<uid>` domain needs; `null` on Windows. */
  uid?: number | null;
}

function ok(result: ExecResult): boolean {
  return result.error === undefined && result.status === 0;
}

/** Why a command failed, in one line. Never carries the token: no command here takes one. */
function why(command: string, result: ExecResult): string {
  if (result.error !== undefined) {
    return `${command}: ${result.error.message}`;
  }
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0];
  return `${command} exited with ${result.status}${detail ? `: ${detail}` : ''}`;
}

/** The real autostart for `host.platform` (spec 151, Decision 2). */
export function platformAutostart(options: AutostartOptions = {}): Autostart {
  const exec = options.exec ?? spawnExec;
  const taskName = options.taskName ?? DEFAULT_TASK_NAME;
  const uid =
    options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;

  const systemctl = (...args: string[]) =>
    exec('systemctl', ['--user', ...args]);

  const linux: Autostart = {
    installed: (host) => existsSync(requireFile(host)),
    install(host, daemon) {
      const file = requireFile(host);
      const existed = existsSync(file);
      mkdirSync(pathFor(host.platform).dirname(file), { recursive: true });
      writeFileSync(file, systemdUnit(daemon));
      const reload = systemctl('daemon-reload');
      const enable = ok(reload)
        ? systemctl('enable', '--now', SYSTEMD_UNIT)
        : reload;
      if (!ok(enable)) {
        if (!existed) rmSync(file, { force: true });
        throw new Error(
          `Cannot register the systemd user unit (${why('systemctl --user', enable)})`,
        );
      }
      return { started: true, warnings: [] };
    },
    uninstall(host) {
      const file = requireFile(host);
      if (!existsSync(file)) return { removed: false, warnings: [] };
      const warnings: string[] = [];
      const disable = systemctl('disable', '--now', SYSTEMD_UNIT);
      if (!ok(disable)) warnings.push(why('systemctl --user disable', disable));
      rmSync(file, { force: true });
      const reload = systemctl('daemon-reload');
      if (!ok(reload))
        warnings.push(why('systemctl --user daemon-reload', reload));
      return { removed: true, warnings };
    },
  };

  const domain = (): string => {
    if (uid === null) throw new Error('launchd needs a user id');
    return `gui/${uid}`;
  };

  const mac: Autostart = {
    installed: (host) => existsSync(requireFile(host)),
    install(host, daemon) {
      const file = requireFile(host);
      const existed = existsSync(file);
      mkdirSync(pathFor(host.platform).dirname(file), { recursive: true });
      writeFileSync(file, launchdPlist(daemon));
      // A loaded copy of an older plist would keep running the old command.
      exec('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
      const boot = exec('launchctl', ['bootstrap', domain(), file]);
      if (!ok(boot)) {
        if (!existed) rmSync(file, { force: true });
        throw new Error(
          `Cannot load the LaunchAgent (${why('launchctl bootstrap', boot)})`,
        );
      }
      // RunAtLoad starts it as it is loaded.
      return { started: true, warnings: [] };
    },
    uninstall(host) {
      const file = requireFile(host);
      if (!existsSync(file)) return { removed: false, warnings: [] };
      // Not loaded (never logged in to, or already booted out) is an expected failure.
      exec('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
      rmSync(file, { force: true });
      return { removed: true, warnings: [] };
    },
  };

  const windows: Autostart = {
    installed: () => ok(exec('schtasks', ['/Query', '/TN', taskName])),
    install(host, daemon) {
      // `schtasks /XML` reads UTF-16 LE with a byte-order mark.
      const dir = mkdtempSync(path.join(tmpdir(), 'demoflow-task-'));
      const xml = path.join(dir, 'task.xml');
      try {
        writeFileSync(
          xml,
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(windowsTaskXml(daemon, windowsUser(host)), 'utf16le'),
          ]),
        );
        const create = exec('schtasks', [
          '/Create',
          '/TN',
          taskName,
          '/XML',
          xml,
          '/F',
        ]);
        if (!ok(create)) {
          throw new Error(
            `Cannot register the scheduled task (${why('schtasks /Create', create)})`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const run = exec('schtasks', ['/Run', '/TN', taskName]);
      const result: InstallResult = { started: ok(run), warnings: [] };
      if (!ok(run)) result.warnings.push(why('schtasks /Run', run));
      return result;
    },
    uninstall() {
      if (!ok(exec('schtasks', ['/Query', '/TN', taskName]))) {
        return { removed: false, warnings: [] };
      }
      const warnings: string[] = [];
      // Ends a running instance; fails harmlessly when none runs.
      exec('schtasks', ['/End', '/TN', taskName]);
      const remove = exec('schtasks', ['/Delete', '/TN', taskName, '/F']);
      if (!ok(remove)) {
        throw new Error(
          `Cannot remove the scheduled task (${why('schtasks /Delete', remove)})`,
        );
      }
      return { removed: true, warnings } satisfies UninstallResult;
    },
  };

  const forHost = (host: HostEnvironment): Autostart =>
    host.platform === 'win32'
      ? windows
      : host.platform === 'darwin'
        ? mac
        : linux;

  return {
    installed: (host) => forHost(host).installed(host),
    install: (host, daemon: DaemonCommand) =>
      forHost(host).install(host, daemon),
    uninstall: (host) => forHost(host).uninstall(host),
  };
}

function requireFile(host: HostEnvironment): string {
  const file = autostartFile(host);
  if (file === null) throw new Error('no autostart file on this platform');
  return file;
}
