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
import {
  describeError,
  EXIT_STAGE_FAILED,
  isInputError,
} from './commands/errors.ts';
import { type Io, processIo } from './commands/io.ts';
import { type LoginFlags, loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { runCommand } from './commands/run.ts';
import { setupCommand } from './commands/setup.ts';
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
    .description('Run a scenario and render its video')
    .argument('<scenario>', 'path to a .demo.json file')
    .option('--base-url <url>', 'override baseUrl from demoflow.config.json')
    .option('--out <dir>', 'artifacts directory (the home of runs/)')
    .option('--headed', 'show the browser window')
    .option('--json', 'print the result as one JSON object on stdout')
    .addOption(
      new Option(
        '--format <format>',
        `a file to render, repeatable; replaces render.formats (${RENDER_FORMATS.join(', ')})`,
      ).argParser(collectFormat),
    )
    .addOption(new Option('--run-id <id>', 'name the run directory').hideHelp())
    .addOption(new Option('--project <dir>', 'the project root').hideHelp())
    .action(
      async (
        scenario: string,
        flags: {
          baseUrl?: string;
          out?: string;
          headed?: boolean;
          json?: boolean;
          format?: RenderFormat[];
          runId?: string;
          project?: string;
        },
      ) => {
        exitCode = await runCommand(scenario, flags, io);
      },
    );

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
      'the DemoFlow server (default: DEMOFLOW_SERVER or staging)',
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
