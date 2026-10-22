import type { HostEnvironment } from '../../config/platform.ts';
import { pathFor } from '../../config/platform.ts';

/** The daemon's command line: absolute `node`, absolute CLI entry, `runner --foreground`. */
export interface DaemonCommand {
  command: string;
  args: string[];
}

export const SYSTEMD_UNIT = 'demoflow-runner.service';
export const LAUNCHD_LABEL = 'dev.demoflow.runner';
export const DEFAULT_TASK_NAME = 'DemoFlowRunner';

const DESCRIPTION = 'DemoFlow runner';

/**
 * Where the unit or plist goes; `null` on Windows, where the task lives in
 * the Task Scheduler and not in a file.
 */
export function autostartFile(host: HostEnvironment): string | null {
  const p = pathFor(host.platform);
  if (host.platform === 'win32') return null;
  if (host.platform === 'darwin') {
    return p.join(
      host.homedir,
      'Library',
      'LaunchAgents',
      `${LAUNCHD_LABEL}.plist`,
    );
  }
  const configHome = host.env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && configHome !== '' && p.isAbsolute(configHome)
      ? configHome
      : p.join(host.homedir, '.config');
  return p.join(base, 'systemd', 'user', SYSTEMD_UNIT);
}

/**
 * One systemd word, always quoted. Inside quotes `\` and `"` are escaped, and
 * `%` and `$` are doubled so systemd does not expand specifiers or variables.
 */
function systemdWord(word: string): string {
  const escaped = word
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

/**
 * `Restart=on-failure`: a clean exit (stopped, or revoked — which exits 0 on
 * purpose) is never revived, so a token that can no longer connect is not
 * retried.
 */
export function systemdUnit(daemon: DaemonCommand): string {
  const exec = [daemon.command, ...daemon.args].map(systemdWord).join(' ');
  return [
    '[Unit]',
    `Description=${DESCRIPTION}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** `KeepAlive` → `SuccessfulExit: false` restarts a crash and leaves a clean exit alone. */
export function launchdPlist(daemon: DaemonCommand): string {
  const words = [daemon.command, ...daemon.args]
    .map((word) => `    <string>${xmlEscape(word)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    words,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** `DOMAIN\user`, or just the user; `null` when the environment names neither. */
export function windowsUser(host: HostEnvironment): string | null {
  const user = host.env.USERNAME;
  if (user === undefined || user === '') return null;
  const domain = host.env.USERDOMAIN;
  return domain === undefined || domain === '' ? user : `${domain}\\${user}`;
}

/** One argument of a Windows command line, quoted when it needs it. */
function windowsArgument(arg: string): string {
  return /[\s"]/.test(arg) || arg === ''
    ? `"${arg.replaceAll('"', '\\"')}"`
    : arg;
}

/**
 * The task definition for `schtasks /Create /XML`. The bare
 * `/SC ONLOGON` form gets Task Scheduler's defaults — killed after 72 hours,
 * not started on battery, stopped when the laptop unplugs, triggered by any
 * user's logon — none of which fit a daemon, so the settings are explicit.
 * Windows has no restart-on-failure that fits `--foreground`'s exit codes
 * either, so the task is started at logon and not restarted.
 */
export function windowsTaskXml(
  daemon: DaemonCommand,
  user: string | null,
): string {
  const userId = user === null ? '' : `<UserId>${xmlEscape(user)}</UserId>`;
  const args = daemon.args.map(windowsArgument).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${DESCRIPTION}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    userId === '' ? '' : `      ${userId}`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    userId === '' ? '' : `      ${userId}`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(daemon.command)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\r\n');
}
