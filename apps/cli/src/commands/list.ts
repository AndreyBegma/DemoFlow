import path from 'node:path';
import {
  currentHost,
  EXIT_INVALID_INPUT,
  type HostEnvironment,
} from '../config/index.ts';
import { ToolError } from '../mcp/errors.ts';
import { resolveProject } from '../mcp/project.ts';
import {
  DEFAULT_LIST_LIMIT,
  type DemoSummary,
  listDemos,
  MAX_LIST_LIMIT,
} from '../mcp/readonly.ts';
import { CommandError } from './errors.ts';
import type { Io } from './io.ts';

export interface ListFlags {
  /** `--limit`, as typed: validated here, before any file is read. */
  limit?: string;
  json?: boolean;
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface ListDeps {
  host: HostEnvironment;
  cwd: string;
}

export function defaultListDeps(): ListDeps {
  return { host: currentHost(), cwd: process.cwd() };
}

/**
 * `demoflow list` (spec 266): the MCP's `list_demos` on the command line.
 * Read-only: no browser, no file written, no network.
 */
export async function listCommand(
  flags: ListFlags,
  io: Io,
  deps: ListDeps = defaultListDeps(),
): Promise<number> {
  const limit = parseLimit(flags.limit);
  const project =
    flags.project === undefined
      ? undefined
      : path.resolve(deps.cwd, flags.project);
  try {
    const listed = await listDemos({ project, limit }, deps.cwd, deps.host);
    if (flags.json === true) {
      io.stdout(`${JSON.stringify(listed)}\n`);
    } else if (listed.demos.length === 0) {
      const { home } = resolveProject(project, deps.cwd, deps.host);
      io.stdout(`No runs yet in ${path.join(home, 'runs')}.\n`);
    } else {
      io.stdout(listed.demos.map(formatDemo).join(''));
    }
    return 0;
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`${error.message}\nhint: ${error.hint}\n`);
      return EXIT_INVALID_INPUT;
    }
    throw error;
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new CommandError(
      'invalid-limit',
      `--limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${JSON.stringify(raw)}`,
    );
  }
  return limit;
}

/** `<status>  <started, local>  <duration>  <scenario>  <run id>`, then the page URL if reported. */
function formatDemo(demo: DemoSummary): string {
  const duration =
    demo.durationMs === undefined
      ? '-'
      : `${(demo.durationMs / 1000).toFixed(1)}s`;
  const line = `${demo.status}  ${formatStarted(demo.startedAt)}  ${duration}  ${demo.scenarioName}  ${demo.taskId}\n`;
  return demo.pageUrl === undefined ? line : `${line}  ${demo.pageUrl}\n`;
}

/** `YYYY-MM-DD HH:mm` in the local time zone. */
export function formatStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
