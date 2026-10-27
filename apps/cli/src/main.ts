#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RENDER_FORMATS, type RenderFormat } from '@demoflow/core';
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander';
import { type CheckFlags, checkCommand } from './commands/check.ts';
import {
  describeError,
  EXIT_STAGE_FAILED,
  isInputError,
} from './commands/errors.ts';
import {
  DEFAULT_BASE_URL,
  type InitFlags,
  initCommand,
} from './commands/init.ts';
import { type Io, processIo } from './commands/io.ts';
import { type ListFlags, listCommand } from './commands/list.ts';
import { type LoginFlags, loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { type RenderFlags, renderCommand } from './commands/render.ts';
import { runCommand } from './commands/run.ts';
import { registerRunsCommands } from './commands/runs.ts';
import { setupCommand } from './commands/setup.ts';
import {
  PASSWORD_ENV,
  type ShareFlags,
  shareCommand,
} from './commands/share.ts';
import { validateCommand } from './commands/validate.ts';
import { mcpCommand } from './mcp/command.ts';
import {
  DEFAULT_NAME,
  DEFAULT_VIEWPORT,
  type RecordFlags,
  recordCommand,
} from './record/command.ts';
import { registerRunnerCommands } from './runner/command.ts';
import { defaultUpdateDeps, withUpdateCheck } from './update/check.ts';
import { packageVersion } from './version.ts';

/**
 * The `demoflow` program. Returns the exit code instead of exiting, so the
 * caller decides when to leave and stdout is flushed first.
 */
export async function main(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  let exitCode = 0;
  const program = new Command('demoflow')
    .description('Turn a scenario into a demo video')
    .version(packageVersion())
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  program
    .command('validate')
    .description('Check a scenario against the schema')
    .argument('<scenario>', 'path to a .demo.json file')
    .action((scenario: string) => {
      exitCode = validateCommand(scenario, io);
    });

  program
    .command('run')
    .description(
      'Run a scenario and render its video; with --check, run and verify only',
    )
    .argument(
      '[scenario]',
      'path to a .demo.json file; required unless --check, which then runs every scenario',
    )
    .option('--base-url <url>', 'override baseUrl from demoflow.config.json')
    .option(
      '--port <n>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's own syntax.
      'fill ${PORT} in demoflow.config.json and set PORT for the app',
    )
    .option(
      '--fresh-app',
      'refuse to run when readyUrl already answers, instead of reusing that app',
    )
    .option('--out <dir>', 'artifacts directory (the home of runs/)')
    .option('--headed', 'show the browser window')
    .option('--json', 'print the result as one JSON object on stdout')
    .addOption(
      new Option(
        '--format <format>',
        `a file to render, repeatable; replaces render.formats (${RENDER_FORMATS.join(', ')})`,
      ).argParser(collectFormat),
    )
    .option(
      '--check',
      'run and verify against the live app, recording and rendering nothing (demoflow check only validates files)',
    )
    .addOption(
      new Option(
        '--exclude <id>',
        'with --check and no scenario: leave out this scenario id, repeatable',
      ).argParser(collectExclude),
    )
    .addOption(new Option('--run-id <id>', 'name the run directory').hideHelp())
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .addOption(
      new Option(
        '--progress',
        'print a JSON line on stdout per phase and step',
      ).hideHelp(),
    )
    .action(
      async (
        scenario: string | undefined,
        flags: {
          baseUrl?: string;
          port?: string;
          freshApp?: boolean;
          out?: string;
          headed?: boolean;
          json?: boolean;
          format?: RenderFormat[];
          check?: boolean;
          exclude?: string[];
          runId?: string;
          project?: string;
          progress?: boolean;
        },
        command: Command,
      ) => {
        if (scenario === undefined && flags.check !== true) {
          command.error("error: missing required argument 'scenario'", {
            code: 'commander.missingArgument',
          });
        }
        exitCode = await runCommand(scenario, flags, io);
      },
    );

  program
    .command('render')
    .description('Render an existing run again with the current render config')
    .argument('<runId>', 'the run directory under <home>/runs/')
    .option('--out <dir>', 'artifacts directory (the home of runs/)')
    .option('--json', 'print the result as one JSON object on stdout')
    .addOption(
      new Option(
        '--format <format>',
        `a file to render, repeatable; replaces render.formats (${RENDER_FORMATS.join(', ')})`,
      ).argParser(collectFormat),
    )
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(async (runId: string, flags: RenderFlags) => {
      exitCode = await renderCommand(runId, flags, io);
    });

  program
    .command('share')
    .description('Share a render of a reported run as a link on the website')
    .argument('<runId>', 'the run directory under <home>/runs/')
    .addOption(
      new Option(
        '--format <format>',
        `the render to share (default: the run's first; ${RENDER_FORMATS.join(', ')})`,
      ).argParser(parseFormat),
    )
    .option(
      '--expires <days>',
      'how long the link works: 7, 30 or 90 days',
      '30',
    )
    .option(
      '--password',
      `protect the link with a password, asked for on the terminal (else ${PASSWORD_ENV})`,
    )
    .option('--json', 'print the share as one JSON object on stdout')
    .option('--out <dir>', 'artifacts directory (the home of runs/)')
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(async (runId: string, flags: ShareFlags) => {
      exitCode = await shareCommand(runId, flags, io);
    });

  program
    .command('list')
    .description('List recent runs of the current project, newest first')
    .option('--limit <n>', 'how many runs to list, 1-100 (default 20)')
    .option('--json', 'print the runs as one JSON object on stdout')
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(async (flags: ListFlags) => {
      exitCode = await listCommand(flags, io);
    });

  program
    .command('check')
    .description('Check that the project, FFmpeg and the browser are ready')
    .option('--json', 'print the check as one JSON object on stdout')
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(async (flags: CheckFlags) => {
      exitCode = await checkCommand(flags, io);
    });

  program
    .command('init')
    .description('Write demoflow.config.json and a first scenario here')
    .option(
      '--base-url <url>',
      `the app's base URL (default ${DEFAULT_BASE_URL})`,
    )
    .action(async (flags: InitFlags) => {
      exitCode = await initCommand(flags, io);
    });

  program
    .command('record')
    .description('Record a scenario by using the app in a browser')
    .argument(
      '[name]',
      'the scenario name; the file is demoflow/<name>.demo.json',
      DEFAULT_NAME,
    )
    .option('--force', 'overwrite an existing scenario file')
    .option('--no-run', 'do not offer to run the scenario after saving it')
    .option(
      '--viewport <WxH>',
      'the browser viewport, written into the scenario',
      DEFAULT_VIEWPORT,
    )
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(async (name: string, flags: RecordFlags) => {
      exitCode = await recordCommand(name, flags, io);
    });

  program
    .command('setup')
    .description('Install Chromium now instead of on the first run')
    .action(async () => {
      exitCode = await setupCommand(io);
    });

  program
    .command('login')
    .description('Pair this machine with your DemoFlow account')
    .option(
      '--server <url>',
      'the DemoFlow server (default: DEMOFLOW_SERVER or production)',
    )
    .option('--force', 'pair again, revoking the stored token first')
    .option('--start', 'start the runner afterwards, without asking')
    .option('--no-start', 'do not start the runner, and do not ask')
    .action(async (flags: LoginFlags) => {
      exitCode = await loginCommand(flags, io);
    });

  program
    .command('logout')
    .description('Revoke this machine and delete its credentials')
    .action(async () => {
      exitCode = await logoutCommand(io);
    });

  registerRunsCommands(program, io, (code) => {
    exitCode = code;
  });

  registerRunnerCommands(program, io, (code) => {
    exitCode = code;
  });

  program
    .command('mcp')
    .description('Serve demo generation to MCP clients over stdio')
    .addHelpText(
      'after',
      '\nRegister with Claude Code:\n  claude mcp add demoflow -- npx demoflow mcp\n',
    )
    .action(async () => {
      exitCode = await mcpCommand(io);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (isInputError(error)) {
      io.stderr(`${describeError(error)}\n`);
      return error.exitCode;
    }
    // commander's own errors (usage, --help, --version) carry their code.
    if (isCommanderError(error))
      return error.exitCode === 1 ? 2 : error.exitCode;
    io.stderr(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return EXIT_STAGE_FAILED;
  }
}

/** `--format`, once per file: a known format, each at most once (spec 133). */
function collectFormat(
  value: string,
  previous: RenderFormat[] = [],
): RenderFormat[] {
  const format = RENDER_FORMATS.find((known) => known === value);
  if (format === undefined) {
    throw new InvalidArgumentError(
      `expected one of ${RENDER_FORMATS.join(', ')}`,
    );
  }
  if (previous.includes(format)) {
    throw new InvalidArgumentError(`${format} is given twice`);
  }
  return [...previous, format];
}

/** `--format` of `share`: one known format. */
function parseFormat(value: string): RenderFormat {
  return collectFormat(value)[0] as RenderFormat;
}

function collectExclude(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

// The bin is a symlink on npm installs: compare real paths.
const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(entry)).href
) {
  const argv = process.argv.slice(2);
  // Spec 166: the npm check runs beside the command and asks after it.
  process.exitCode = await withUpdateCheck(
    argv,
    () => main(argv),
    defaultUpdateDeps(),
  );
}
