import path from 'node:path';
import {
  currentHost,
  EXIT_INVALID_INPUT,
  type HostEnvironment,
} from '../config/index.ts';
import { ToolError } from '../mcp/errors.ts';
import { checkProject, type ProjectCheck } from '../mcp/readonly.ts';
import type { Io } from './io.ts';

export interface CheckFlags {
  json?: boolean;
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface CheckDeps {
  host: HostEnvironment;
  cwd: string;
  /** Defaults to `checkProject`; tests fake FFmpeg and the browser. */
  check?: typeof checkProject;
}

export function defaultCheckDeps(): CheckDeps {
  return { host: currentHost(), cwd: process.cwd() };
}

/**
 * `demoflow check` (spec 266): the MCP's `check_project` on the command line.
 * Exit 0 when FFmpeg and the browser are available, 1 when either is missing.
 * Read-only: no browser, no file written, no network.
 */
export async function checkCommand(
  flags: CheckFlags,
  io: Io,
  deps: CheckDeps = defaultCheckDeps(),
): Promise<number> {
  const project =
    flags.project === undefined
      ? undefined
      : path.resolve(deps.cwd, flags.project);
  let checked: ProjectCheck;
  try {
    checked = await (deps.check ?? checkProject)(
      { project },
      deps.cwd,
      deps.host,
    );
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`${error.message}\nhint: ${error.hint}\n`);
      return EXIT_INVALID_INPUT;
    }
    throw error;
  }
  io.stdout(
    flags.json === true ? `${JSON.stringify(checked)}\n` : format(checked),
  );
  return checked.ffmpeg === 'missing' || checked.browser === 'missing'
    ? EXIT_NOT_READY
    : 0;
}

/** Exit code `1`: the project is fine but a demo cannot run here yet. */
const EXIT_NOT_READY = 1;

function format(check: ProjectCheck): string {
  const lines = [
    `root: ${check.root}`,
    `config: ${check.configValid ? 'valid' : 'invalid'}`,
    'scenarios:',
    ...(check.scenarios.length === 0
      ? ['  none']
      : check.scenarios.map((scenario) => `  ${scenario}`)),
    `ffmpeg: ${check.ffmpeg}`,
    `browser: ${check.browser}`,
  ];
  if (check.browser === 'missing') lines.push('hint: run demoflow setup');
  return `${lines.join('\n')}\n`;
}
