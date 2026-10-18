#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import {
  describeError,
  EXIT_STAGE_FAILED,
  isInputError,
} from './commands/errors.ts';
import { type Io, processIo } from './commands/io.ts';
import { runCommand } from './commands/run.ts';
import { validateCommand } from './commands/validate.ts';

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
    .action(
      async (
        scenario: string,
        flags: {
          baseUrl?: string;
          out?: string;
          headed?: boolean;
          json?: boolean;
        },
      ) => {
        exitCode = await runCommand(scenario, flags, io);
      },
    );

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

function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

// The bin is a symlink on npm installs: compare real paths.
const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(entry)).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
