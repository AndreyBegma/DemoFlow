import { describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../../src/config/platform.ts';
import {
  autostartFile,
  type DaemonCommand,
  launchdPlist,
  systemdUnit,
  windowsTaskXml,
  windowsUser,
} from '../../../src/runner/install/units.ts';

const plain: DaemonCommand = {
  command: '/usr/bin/node',
  args: ['/opt/demoflow/dist/main.js', 'runner', '--foreground'],
};

const spaced: DaemonCommand = {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\Users\\Ada & Co\\demo "flow"\\main.js', 'runner', '--foreground'],
};

describe('systemd user unit', () => {
  it('runs the absolute node and CLI paths in the foreground', () => {
    const unit = systemdUnit(plain);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/demoflow/dist/main.js" "runner" "--foreground"',
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('restarts on failure only, so a revoked daemon (exit 0) stays down', () => {
    const unit = systemdUnit(plain);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  it('quotes a path with spaces, quotes, percent signs and dollars', () => {
    const unit = systemdUnit({
      command: '/usr/bin/node',
      args: ['/home/a b/"x"/100%/$HOME/main.js', 'runner', '--foreground'],
    });
    expect(unit).toContain('"/home/a b/\\"x\\"/100%%/$$HOME/main.js"');
  });
});

describe('LaunchAgent plist', () => {
  it('has the label, RunAtLoad and KeepAlive on crash only', () => {
    const plist = launchdPlist(plain);
    expect(plist).toContain('<string>dev.demoflow.runner</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });

  it('lists the command and each argument as its own string', () => {
    const plist = launchdPlist(plain);
    for (const word of [plain.command, ...plain.args]) {
      expect(plist).toContain(`<string>${word}</string>`);
    }
  });

  it('escapes XML in a path', () => {
    const plist = launchdPlist({
      command: '/Users/Ada & Co/node',
      args: ['/a<b>/main.js', 'runner', '--foreground'],
    });
    expect(plist).toContain('<string>/Users/Ada &amp; Co/node</string>');
    expect(plist).toContain('<string>/a&lt;b&gt;/main.js</string>');
  });
});

describe('Task Scheduler task', () => {
  const xml = windowsTaskXml(spaced, 'WORK\\ada');

  it('is a logon trigger for the current user, without admin rights', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>WORK\\ada</UserId>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('drops the defaults that would kill a daemon', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain(
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    );
    expect(xml).toContain(
      '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    );
    expect(xml).not.toContain('RestartOnFailure');
  });

  it('runs the absolute node with the quoted CLI path', () => {
    expect(xml).toContain(
      '<Command>C:\\Program Files\\nodejs\\node.exe</Command>',
    );
    expect(xml).toContain(
      '<Arguments>&quot;C:\\Users\\Ada &amp; Co\\demo \\&quot;flow\\&quot;\\main.js&quot; runner --foreground</Arguments>',
    );
  });

  it('omits the user when the environment names none', () => {
    expect(windowsTaskXml(plain, null)).not.toContain('<UserId>');
  });

  it.each([
    [{ USERNAME: 'ada', USERDOMAIN: 'WORK' }, 'WORK\\ada'],
    [{ USERNAME: 'ada' }, 'ada'],
    [{}, null],
  ])('names the user from %j', (env, expected) => {
    const host: HostEnvironment = {
      platform: 'win32',
      env,
      homedir: 'C:\\Users\\ada',
    };
    expect(windowsUser(host)).toBe(expected);
  });
});

describe('autostart file location', () => {
  it('is the systemd user directory on Linux', () => {
    expect(
      autostartFile({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/cfg' },
        homedir: '/home/ada',
      }),
    ).toBe('/cfg/systemd/user/demoflow-runner.service');
    expect(
      autostartFile({ platform: 'linux', env: {}, homedir: '/home/ada' }),
    ).toBe('/home/ada/.config/systemd/user/demoflow-runner.service');
  });

  it('is the LaunchAgents directory on macOS', () => {
    expect(
      autostartFile({ platform: 'darwin', env: {}, homedir: '/Users/ada' }),
    ).toBe('/Users/ada/Library/LaunchAgents/dev.demoflow.runner.plist');
  });

  it('is none on Windows: the task lives in the Task Scheduler', () => {
    expect(
      autostartFile({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ada' }),
    ).toBeNull();
  });
});

describe('no token in a generated file', () => {
  it('never carries a dfr_ value: the daemon reads credentials.json', () => {
    for (const text of [
      systemdUnit(plain),
      launchdPlist(plain),
      windowsTaskXml(plain, 'ada'),
    ]) {
      expect(text).not.toContain('dfr_');
    }
  });
});
