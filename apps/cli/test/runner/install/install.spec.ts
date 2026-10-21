import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredentials } from '../../../src/auth/credentials.ts';
import type { Io } from '../../../src/commands/io.ts';
import type { HostEnvironment } from '../../../src/config/platform.ts';
import { defaultControlDeps } from '../../../src/runner/control.ts';
import {
  type Exec,
  platformAutostart,
  spawnExec,
} from '../../../src/runner/install/autostart.ts';
import {
  installCommand,
  uninstallCommand,
} from '../../../src/runner/install/commands.ts';
import {
  autostartFile,
  type DaemonCommand,
} from '../../../src/runner/install/units.ts';

const TOKEN = 'dfr_0123456789abcdef0123456789abcdef';
const onWindows = process.platform === 'win32';

/**
 * Exits at once, so the `start now` of a real install runs a no-op and never
 * the daemon — whose home would be this machine's, not the temp one.
 */
const noop: DaemonCommand = { command: process.execPath, args: ['-e', '0'] };

// One task name for the whole run; every test that registers a task removes it.
const taskName = `DemoFlowRunnerTest-${process.pid}-${Date.now()}`;

let tmp: string;
let host: HostEnvironment;
let out: string;
let calls: string[];

const io: Io = {
  stdout: (text) => {
    out += text;
  },
  stderr: (text) => {
    out += text;
  },
};

/**
 * Linux and macOS register with a service manager that was started with the
 * real user's HOME: it neither sees a temp HOME nor should it be handed
 * something to run on a CI machine. So their `systemctl` / `launchctl` calls
 * are recorded and answered with success; the unit and plist files are real.
 * Windows has no such problem (the task name is unique), so it runs for real.
 */
const recording: Exec = (command, args) => {
  calls.push([command, ...args].join(' '));
  return { status: 0, stdout: '', stderr: '' };
};
const exec: Exec = onWindows ? spawnExec : recording;

function deps() {
  return {
    ...defaultControlDeps(),
    host,
    daemon: noop,
    autostart: platformAutostart({ exec, taskName, uid: 501 }),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'demoflow-install-'));
  host = {
    platform: process.platform,
    env: {
      ...process.env,
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
      APPDATA: tmp,
    },
    homedir: tmp,
  };
  out = '';
  calls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterAll(() => {
  if (onWindows) {
    spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], {
      windowsHide: true,
    });
  }
});

function login(): void {
  writeCredentials(host, {
    server: 'http://localhost:3670',
    token: TOKEN,
    runnerId: 'run_1',
  });
}

describe('runner install / uninstall', () => {
  it('refuses without a credential file and installs nothing', () => {
    expect(installCommand(io, deps())).toBe(1);
    expect(out).toContain('demoflow login');
    expect(deps().autostart.installed(host)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('installs, reports it in status, and uninstalls', () => {
    login();
    expect(deps().autostart.installed(host)).toBe(false);

    expect(installCommand(io, deps())).toBe(0);
    expect(out).toContain('Autostart installed; runner started');
    expect(deps().autostart.installed(host)).toBe(true);

    out = '';
    expect(uninstallCommand(io, deps())).toBe(0);
    expect(out).toContain('Autostart removed');
    expect(deps().autostart.installed(host)).toBe(false);
    const file = autostartFile(host);
    if (file !== null) expect(existsSync(file)).toBe(false);
  });

  it('installs again over an existing install', () => {
    login();
    expect(installCommand(io, deps())).toBe(0);
    expect(installCommand(io, deps())).toBe(0);
    expect(deps().autostart.installed(host)).toBe(true);
    expect(uninstallCommand(io, deps())).toBe(0);
  });

  it('uninstalling when nothing is installed is not an error', () => {
    expect(uninstallCommand(io, deps())).toBe(0);
    expect(out).toContain('Autostart is not installed');
  });

  it('writes the absolute daemon command and no token', () => {
    login();
    expect(installCommand(io, deps())).toBe(0);
    const file = autostartFile(host);
    if (file !== null) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(process.execPath);
      expect(text).not.toContain('dfr_');
      expect(statSync(file).isFile()).toBe(true);
    }
    expect(out).not.toContain('dfr_');
    expect(uninstallCommand(io, deps())).toBe(0);
  });

  it.skipIf(onWindows)(
    'tells the service manager to load, then to unload',
    () => {
      login();
      installCommand(io, deps());
      const loading =
        process.platform === 'darwin' ? 'bootstrap' : 'enable --now';
      expect(calls.some((call) => call.includes(loading))).toBe(true);
      calls = [];
      uninstallCommand(io, deps());
      const unloading =
        process.platform === 'darwin' ? 'bootout' : 'disable --now';
      expect(calls.some((call) => call.includes(unloading))).toBe(true);
    },
  );

  it('fails and leaves nothing behind when the service manager refuses', () => {
    if (onWindows) return;
    login();
    const refusing: Exec = () => ({
      status: 1,
      stdout: '',
      stderr: 'Failed to connect to bus',
    });
    const failing = {
      ...deps(),
      autostart: platformAutostart({ exec: refusing, uid: 501 }),
    };
    expect(installCommand(io, failing)).toBe(1);
    expect(out).toContain('Failed to connect to bus');
    const file = autostartFile(host);
    if (file !== null) expect(existsSync(file)).toBe(false);
  });
});

describe('the generated file under the real tool', () => {
  it.skipIf(process.platform !== 'linux')(
    'is accepted by systemd-analyze when a user manager exists',
    () => {
      const probe = spawnSync('systemd-analyze', ['--version'], {
        encoding: 'utf8',
      });
      if (probe.error !== undefined || probe.status !== 0) return;
      login();
      installCommand(io, deps());
      const file = autostartFile(host);
      if (file === null) throw new Error('no unit file');
      // `ExecStart` must point at a real file for `verify`; node is one.
      const verify = spawnSync('systemd-analyze', ['--user', 'verify', file], {
        encoding: 'utf8',
      });
      // A sandbox without a user manager cannot verify: that is not a bad unit.
      if (/bus|manager/i.test(verify.stderr)) return;
      expect(verify.stderr).not.toMatch(/Unknown|Invalid|Failed to parse/i);
    },
  );

  it.skipIf(process.platform !== 'darwin')('is accepted by plutil', () => {
    login();
    installCommand(io, deps());
    const file = autostartFile(host);
    if (file === null) throw new Error('no plist');
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });
});
