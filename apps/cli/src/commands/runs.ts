import { type Command, Option } from 'commander';
import {
  CliError,
  currentHost,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  pathFor,
  projectRootAbove,
  projectRootAt,
  resolveHome,
} from '../config/index.ts';
import { runnerPaths } from '../runner/paths.ts';
import {
  pageUrlFor,
  readReportedRunsByDir,
} from '../runs-report/reported-runs.ts';
import { CommandError } from './errors.ts';
import type { Io } from './io.ts';
import { formatStarted } from './list.ts';
import { assertSafeRunId } from './run-id.ts';
import {
  formatSize,
  type LocalRun,
  nodeRunsFs,
  parseDuration,
  type RunsFs,
  removeRun,
  scanRuns,
} from './runs-scan.ts';

interface HomeFlags {
  out?: string;
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface RunsListFlags extends HomeFlags {
  json?: boolean;
}

export interface RunsDeleteFlags extends HomeFlags {
  dryRun?: boolean;
}

export interface RunsPruneFlags extends HomeFlags {
  /** `--older-than`, as typed: validated before anything is read. */
  olderThan?: string;
  partialOnly?: boolean;
  dryRun?: boolean;
}

export interface RunsDeps {
  host: HostEnvironment;
  cwd: string;
  /** Milliseconds since the epoch. */
  now: () => number;
  fs: RunsFs;
}

export function defaultRunsDeps(): RunsDeps {
  return {
    host: currentHost(),
    cwd: process.cwd(),
    now: () => Date.now(),
    fs: nodeRunsFs,
  };
}

const DRY_RUN_HINT =
  '\nNothing asks for confirmation: preview with --dry-run first, e.g.\n  demoflow runs prune --older-than 30d --dry-run\n';

/**
 * `demoflow runs` (spec 283): list, delete and prune the run directories under
 * `<home>/runs/`. A group beside `demoflow list`, which keeps the MCP's contract.
 */
export function registerRunsCommands(
  program: Command,
  io: Io,
  setExit: (code: number) => void,
  deps: () => RunsDeps = defaultRunsDeps,
): Command {
  const runs = program
    .command('runs')
    .description('List, delete and prune the runs on this machine')
    .addHelpText('after', DRY_RUN_HINT);

  homeOptions(
    runs
      .command('list')
      .description('List every run under <home>/runs, newest first, with size')
      .option('--json', 'print the runs as one JSON object on stdout'),
  ).action(async (flags: RunsListFlags) => {
    setExit(await runsListCommand(flags, io, deps()));
  });

  homeOptions(
    runs
      .command('delete')
      .description('Delete runs by id')
      .argument('<id...>', 'run directories under <home>/runs/')
      .option('--dry-run', 'print what would be deleted, delete nothing')
      .addHelpText('after', DRY_RUN_HINT),
  ).action(async (ids: string[], flags: RunsDeleteFlags) => {
    setExit(await runsDeleteCommand(ids, flags, io, deps()));
  });

  homeOptions(
    runs
      .command('prune')
      .description('Delete the runs that match every filter given')
      .option(
        '--older-than <duration>',
        'runs started longer ago than this: 90m, 12h, 30d, 2w',
      )
      .option('--partial-only', 'only runs that never finished')
      .option('--dry-run', 'print what would be deleted, delete nothing')
      .addHelpText('after', DRY_RUN_HINT),
  ).action(async (flags: RunsPruneFlags) => {
    setExit(await runsPruneCommand(flags, io, deps()));
  });

  return runs;
}

function homeOptions(command: Command): Command {
  return command
    .option('--out <dir>', 'artifacts directory (the home of runs/)')
    .addOption(new Option('--project <dir>', 'the project root').hideHelp());
}

/** `demoflow runs list` (Decision 4). Writes nothing. */
export async function runsListCommand(
  flags: RunsListFlags,
  io: Io,
  deps: RunsDeps,
): Promise<number> {
  const runsDir = resolveRunsDir(flags, deps);
  const p = pathFor(deps.host.platform);
  const runs = (await scan(runsDir, deps)).sort((a, b) => b.dateMs - a.dateMs);
  const reported = await readReportedRunsByDir(
    runnerPaths(deps.host).reportedRuns,
  );
  const pageUrl = (run: LocalRun) =>
    pageUrlFor(reported, p.join(runsDir, run.id));

  if (flags.json === true) {
    const listed = runs.map((run) => ({
      id: run.id,
      state: run.state,
      status: run.status,
      scenarioName: run.scenarioName,
      scenarioId: run.scenarioId,
      startedAt: run.startedAt,
      modifiedAt: new Date(run.modifiedMs).toISOString(),
      sizeBytes: run.sizeBytes,
      pageUrl: pageUrl(run),
    }));
    io.stdout(`${JSON.stringify({ home: runsDir, runs: listed })}\n`);
    return 0;
  }
  if (runs.length === 0) {
    io.stdout(`No runs in ${runsDir}.\n`);
    return 0;
  }
  const lines = [`Runs in ${runsDir}`];
  for (const run of runs) {
    const column = run.state === 'settled' ? run.status : run.state;
    const date = formatStarted(new Date(run.dateMs).toISOString());
    lines.push(
      `${column}  ${date}  ${formatSize(run.sizeBytes)}  ${run.scenarioName ?? '-'}  ${run.id}`,
    );
    const url = pageUrl(run);
    if (url !== undefined) lines.push(`  ${url}`);
  }
  const total = runs.reduce((sum, run) => sum + run.sizeBytes, 0);
  lines.push(
    `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}, ${formatSize(total)}`,
  );
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * `demoflow runs delete <id...>` (Decision 6): every id is checked before
 * anything is removed; then one line per id, in order. Exit 0 only when every
 * id was deleted (or would be, with `--dry-run`).
 */
export async function runsDeleteCommand(
  ids: string[],
  flags: RunsDeleteFlags,
  io: Io,
  deps: RunsDeps,
): Promise<number> {
  for (const id of ids) assertSafeRunId(id);
  const runsDir = resolveRunsDir(flags, deps);
  const runs = await scan(runsDir, deps);
  const now = deps.now();
  const matches = matcher(deps.host.platform);
  const lines = [`Runs in ${runsDir}`];
  let exitCode = 0;
  let realRuns: string | undefined;
  for (const id of ids) {
    const run = runs.find((candidate) => matches(candidate.id, id));
    if (run === undefined) {
      lines.push(`not found ${id}`);
      exitCode = 1;
    } else if (run.state === 'active') {
      const seconds = Math.max(0, Math.floor((now - run.modifiedMs) / 1000));
      lines.push(
        `refused ${run.id}: modified ${seconds}s ago, it may still be running`,
      );
      exitCode = 1;
    } else if (flags.dryRun === true) {
      lines.push(`would delete ${run.id} (${formatSize(run.sizeBytes)})`);
    } else {
      try {
        realRuns ??= await deps.fs.realpath(runsDir);
        await removeRun(realRuns, run.id, {
          platform: deps.host.platform,
          fs: deps.fs,
        });
        lines.push(`deleted ${run.id} (${formatSize(run.sizeBytes)})`);
        // A repeated id is not found the second time.
        runs.splice(runs.indexOf(run), 1);
      } catch (error) {
        lines.push(`failed ${run.id}: ${messageOf(error)}`);
        exitCode = 1;
      }
    }
  }
  io.stdout(`${lines.join('\n')}\n`);
  return exitCode;
}

/**
 * `demoflow runs prune` (Decision 7): the runs matching every filter given,
 * oldest first. Active runs are skipped and counted. Exit 1 only when a
 * removal failed.
 */
export async function runsPruneCommand(
  flags: RunsPruneFlags,
  io: Io,
  deps: RunsDeps,
): Promise<number> {
  if (flags.olderThan === undefined && flags.partialOnly !== true) {
    throw new CommandError(
      'prune-needs-a-filter',
      'prune deletes nothing without --older-than <duration> or --partial-only',
    );
  }
  const olderThanMs =
    flags.olderThan === undefined ? undefined : parseDuration(flags.olderThan);
  const runsDir = resolveRunsDir(flags, deps);
  const runs = await scan(runsDir, deps);
  const now = deps.now();
  const active = runs.filter((run) => run.state === 'active').length;
  const selected = runs
    .filter(
      (run) =>
        run.state !== 'active' &&
        (flags.partialOnly !== true || run.state === 'partial') &&
        (olderThanMs === undefined || run.dateMs < now - olderThanMs),
    )
    .sort((a, b) => a.dateMs - b.dateMs);

  const lines = [`Runs in ${runsDir}`];
  let freed = 0;
  let exitCode = 0;
  let realRuns: string | undefined;
  for (const run of selected) {
    if (flags.dryRun === true) {
      lines.push(`would delete ${run.id} (${formatSize(run.sizeBytes)})`);
      freed += run.sizeBytes;
      continue;
    }
    try {
      realRuns ??= await deps.fs.realpath(runsDir);
      await removeRun(realRuns, run.id, {
        platform: deps.host.platform,
        fs: deps.fs,
      });
      lines.push(`deleted ${run.id} (${formatSize(run.sizeBytes)})`);
      freed += run.sizeBytes;
    } catch (error) {
      lines.push(`failed ${run.id}: ${messageOf(error)}`);
      exitCode = 1;
    }
  }
  if (active > 0) lines.push(`skipped ${active} active`);
  lines.push(
    `${flags.dryRun === true ? 'Would free' : 'Freed'} ${formatSize(freed)}`,
  );
  io.stdout(`${lines.join('\n')}\n`);
  return exitCode;
}

/**
 * Decision 2: `<home>/runs`. The project is optional — runs outlive projects —
 * so only `no-project-config` is swallowed; an invalid config is still exit 2.
 */
function resolveRunsDir(flags: HomeFlags, deps: RunsDeps): string {
  const { host, cwd } = deps;
  const p = pathFor(host.platform);
  let root: string | undefined;
  try {
    root =
      flags.project === undefined
        ? projectRootAbove(cwd)
        : projectRootAt(p.resolve(cwd, flags.project));
  } catch (error) {
    if (!(error instanceof CliError && error.code === 'no-project-config')) {
      throw error;
    }
  }
  const { home } = resolveHome({
    ...host,
    out: flags.out,
    cwd,
    projectRoot: root ?? cwd,
    projectConfig: root === undefined ? {} : loadProjectConfig(root),
    globalConfig: loadGlobalConfig(host),
  });
  return p.join(home, 'runs');
}

function scan(runsDir: string, deps: RunsDeps): Promise<LocalRun[]> {
  return scanRuns(runsDir, {
    platform: deps.host.platform,
    now: deps.now(),
    fs: deps.fs,
  });
}

/** Decision 6: Windows names are case-insensitive. */
function matcher(
  platform: NodeJS.Platform,
): (name: string, id: string) => boolean {
  return platform === 'win32'
    ? (name, id) => name.toLowerCase() === id.toLowerCase()
    : (name, id) => name === id;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
