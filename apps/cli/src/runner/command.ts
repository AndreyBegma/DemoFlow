import { type Command, Option } from 'commander';
import type { Io } from '../commands/io.ts';
import { currentHost } from '../config/platform.ts';
import {
  defaultControlDeps,
  logsCommand,
  startRunner,
  statusCommand,
  stopRunner,
} from './control.ts';
import { defaultDaemonDeps, runForeground } from './daemon.ts';
import { installCommand, uninstallCommand } from './install/commands.ts';
import {
  allowCommand,
  disallowCommand,
  rootsCommand,
} from './roots/commands.ts';

/**
 * `demoflow runner`: the background daemon of spec 151. The hidden
 * `--foreground` is the daemon itself — what `start` spawns and what the
 * autostart units run.
 */
export function registerRunnerCommands(
  program: Command,
  io: Io,
  setExit: (code: number) => void,
): Command {
  const runner = program
    .command('runner')
    .description('Keep this machine connected to DemoFlow in the background')
    .addOption(
      new Option('--foreground', 'run the daemon in this process').hideHelp(),
    )
    .action(async (flags: { foreground?: boolean }) => {
      if (flags.foreground !== true) {
        runner.help({ error: true });
      }
      setExit(await runForeground(io, defaultDaemonDeps(currentHost())));
    });

  runner
    .command('start')
    .description('Start the runner in the background')
    .action(async () => {
      setExit(await startRunner(io, defaultControlDeps()));
    });

  runner
    .command('stop')
    .description('Stop the runner')
    .action(async () => {
      await stopRunner(io, defaultControlDeps());
      setExit(0);
    });

  runner
    .command('status')
    .description('Show whether the runner is running and connected')
    .option('--json', 'print the status as one JSON object')
    .action((flags: { json?: boolean }) => {
      setExit(statusCommand(flags, io, defaultControlDeps()));
    });

  runner
    .command('logs')
    .description("Print the runner's log")
    .option('-f, --follow', 'keep printing new lines')
    .action(async (flags: { follow?: boolean }) => {
      setExit(await logsCommand(flags, io, defaultControlDeps()));
    });

  runner
    .command('install')
    .description('Start the runner at every login, and now')
    .action(() => {
      setExit(installCommand(io, defaultControlDeps()));
    });

  runner
    .command('uninstall')
    .description('Stop starting the runner at login')
    .action(() => {
      setExit(uninstallCommand(io, defaultControlDeps()));
    });

  const rootsDeps = () => ({ host: currentHost(), cwd: process.cwd() });

  runner
    .command('allow')
    .description('Let the website name folders inside this directory')
    .argument('<dir>', 'an existing directory')
    .action((dir: string) => {
      setExit(allowCommand(dir, io, rootsDeps()));
    });

  runner
    .command('disallow')
    .description('Stop the website naming folders inside this directory')
    .argument('<dir>', 'an allowed root')
    .action((dir: string) => {
      setExit(disallowCommand(dir, io, rootsDeps()));
    });

  runner
    .command('roots')
    .description('List the directories the website may name folders in')
    .option('--json', 'print the roots as one JSON object')
    .action((flags: { json?: boolean }) => {
      setExit(rootsCommand(flags, io, rootsDeps()));
    });

  return runner;
}
