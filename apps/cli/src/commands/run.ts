import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ProjectConfig,
  parsePort,
  type RenderFormat,
  type RunResult,
  type Scenario,
} from '@demoflow/core';
import {
  createCaptureObserver,
  RUN_FILES,
  runScenario,
} from '@demoflow/engine';
import { buildRenderPlan, ffmpegRenderer } from '@demoflow/renderer';
import {
  AppStartError,
  anyAnswer,
  type RunningApp,
  startApp,
} from '../app/dev-server.ts';
import { outputTail } from '../app/output-tail.ts';
import {
  currentHost,
  findProjectRoot,
  type HostEnvironment,
  loadAppConfig,
  loadGlobalConfig,
  PROJECT_CONFIG_FILE,
  projectFragments,
  projectRootAbove,
  projectRootAt,
  resolveHome,
  runDir as runDirFor,
  scenarioId,
} from '../config/index.ts';
import { nodeLaunchFs } from '../runner/launch/checks.ts';
import { LIST_MAX_SCENARIOS, listScenarios } from '../runner/launch/list.ts';
import {
  canonicalRoot,
  defaultReportDeps,
  type ReportDeps,
  reportRun,
} from '../runs-report/report.ts';
import { type BrowserDeps, ensureChromium } from './browser.ts';
import { CommandError, EXIT_STAGE_FAILED } from './errors.ts';
import { exitCodeFor } from './exit.ts';
import type { Io } from './io.ts';
import {
  formatCheckJson,
  formatCheckLine,
  formatJson,
  formatSummary,
} from './output.ts';
import {
  emitCheckProgress,
  emitProgress,
  progressObserver,
} from './progress.ts';
import { renderPlanOptions } from './render.ts';
import { assertSafeRunId, generateRunId } from './run-id.ts';
import { loadScenario } from './scenario-file.ts';
import { settleRun } from './settle.ts';

export interface RunFlags {
  baseUrl?: string;
  /** `--port`: fills `${PORT}` and sets `PORT` for the app (spec 337). */
  port?: string;
  /** `--fresh-app`: refuse an app that already answers on `readyUrl`. */
  freshApp?: boolean;
  out?: string;
  headed?: boolean;
  json?: boolean;
  /** `--format`: replaces `render.formats` for this run (spec 133). */
  format?: RenderFormat[];
  /** Hidden: names the run directory so a caller knows it before the start. */
  runId?: string;
  /** Hidden: the project root, for a scenario file kept outside it (`demoflow mcp`). */
  project?: string;
  /** Hidden: one JSON progress line on stdout per phase change and step (spec 302). */
  progress?: boolean;
  /** `--check`: run and verify, record and render nothing (spec 360). */
  check?: boolean;
  /** `--exclude`: a scenario id a check pass leaves out, repeatable (spec 360). */
  exclude?: string[];
}

export interface RunDeps {
  host: HostEnvironment;
  cwd: string;
  runId: () => string;
  /** Chromium's check and first-use install; Playwright's own by default. */
  browser?: BrowserDeps;
  /** The report to the server after the run; the real one by default. */
  report?: ReportDeps;
  /** Starts `devCommand`; the real start by default. */
  startApp?: typeof startApp;
}

export function defaultRunDeps(): RunDeps {
  return { host: currentHost(), cwd: process.cwd(), runId: generateRunId };
}

/** A scenario about to run, and the run it became. */
interface Planned {
  file: string;
  id: string;
  scenario: Scenario;
}

interface Finished {
  result: RunResult;
  runDir: string;
  /** A render crash before the stage was recorded (an ordinary run only). */
  renderError?: unknown;
}

/**
 * `demoflow run <scenario>`: validate, load the config, resolve the home, run
 * the engine, render, print. Input errors are thrown (exit 2); a finished run
 * returns its exit code.
 *
 * With `--check` (spec 360) nothing is recorded or rendered, and without a
 * scenario every scenario of the project runs, one after another, against one
 * start of the app: a check pass.
 */
export async function runCommand(
  file: string | undefined,
  flags: RunFlags,
  io: Io,
  deps: RunDeps = defaultRunDeps(),
): Promise<number> {
  const { host } = deps;
  const check = flags.check === true;
  if (check) assertCheckFlags(file, flags);
  else if (file === undefined) {
    throw new CommandError(
      'missing-scenario',
      'a scenario is required; only --check runs every scenario of the project',
    );
  }
  const port = flags.port === undefined ? undefined : portFlag(flags.port);
  const root =
    flags.project !== undefined
      ? projectRootAt(path.resolve(deps.cwd, flags.project))
      : file !== undefined
        ? findProjectRoot(file)
        : projectRootAbove(deps.cwd);
  const app = loadAppConfig(root, {
    port,
    baseUrl: flags.baseUrl,
    env: host.env,
  });
  const { config } = app;
  if (port !== undefined && !app.usesPort) {
    io.stderr(
      `warning: --port ${port} is given but ${PROJECT_CONFIG_FILE} uses no \${PORT}; baseUrl and readyUrl are unchanged\n`,
    );
  }
  const { home } = resolveHome({
    ...host,
    out: flags.out,
    cwd: deps.cwd,
    projectRoot: root,
    projectConfig: config,
    globalConfig: loadGlobalConfig(host),
  });
  const files =
    file !== undefined
      ? [file]
      : await passFiles(root, config.fragmentsDir, flags.exclude ?? [], io);
  const fragments = projectFragments(root, config.fragmentsDir);
  const planned: Planned[] = files.map((scenarioFile) => {
    const { scenario, warnings } = loadScenario(scenarioFile, fragments);
    for (const warning of warnings) {
      io.stderr(`warning ${warning.path}: ${warning.message}\n`);
    }
    return { file: scenarioFile, id: scenarioId(root, scenarioFile), scenario };
  });

  if (flags.runId !== undefined) {
    assertSafeRunId(flags.runId);
    const runDir = runDirFor(home, flags.runId, host.platform);
    if (existsSync(runDir)) {
      throw new CommandError(
        'invalid-run-id',
        `run directory already exists: ${runDir}`,
      );
    }
  }
  const fresh = flags.freshApp === true;
  if (fresh) await assertNoAppRunning(config.devCommand);
  // After every input check: a bad scenario never costs a browser download
  // or an app start. The start overlaps with the download; the app's output
  // is kept and shown only if the start fails. A check pass starts the app
  // once for all its scenarios (spec 360, Decision 3).
  const progress = flags.progress === true;
  if (progress) emitProgress(io, { phase: 'app' });
  const tail = outputTail();
  const starting: Promise<Started> = (deps.startApp ?? startApp)(config, root, {
    log: (text) => tail.push(text),
    env: app.port === undefined ? undefined : { PORT: String(app.port) },
    fresh,
  }).then(
    (app) => ({ app }),
    (error: unknown) => ({ error }),
  );
  const stopApp = async (): Promise<void> => {
    const started = await starting;
    if ('app' in started) await started.app.stop();
  };
  const onSignal = (code: number) => () => {
    void stopApp().finally(() => process.exit(code));
  };
  const onInterrupt = onSignal(130);
  const onTerminate = onSignal(143);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    if ((await ensureChromium(io, deps.browser)) === 'failed') {
      return EXIT_STAGE_FAILED;
    }
    const started = await starting;
    if ('error' in started && !(started.error instanceof AppStartError)) {
      throw started.error;
    }
    const output = tail.lines();
    if ('error' in started && output.length > 0) {
      io.stderr(`${output.join('\n')}\n`);
    }
    const finished: Finished[] = [];
    for (const [index, run] of planned.entries()) {
      if (check && progress) {
        emitCheckProgress(io, { run: index + 1, runs: planned.length });
      }
      const runId = flags.runId ?? deps.runId();
      const runDir = runDirFor(home, runId, host.platform);
      const done: Finished =
        'error' in started
          ? {
              result: await writeAppNotReady({
                error: started.error as AppStartError,
                output,
                scenarioName: run.scenario.name,
                scenarioFile: run.id,
                runId,
                runDir,
              }),
              runDir,
            }
          : await execute(run, runId, runDir);
      // A run whose app never answered was never reported before spec 360; a
      // check reports it, so the stale state sees a readiness failure too.
      if (!('error' in started) || check) {
        await reportRun(
          { root, runDir, result: done.result, check },
          deps.report ?? defaultReportDeps(host),
        );
      }
      if (check && flags.json !== true) {
        io.stdout(formatCheckLine(done.result));
      }
      finished.push(done);
    }
    return check ? concludeCheck(finished) : concludeRun(finished);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await stopApp();
  }

  async function execute(
    run: Planned,
    runId: string,
    runDir: string,
  ): Promise<Finished> {
    io.stderr(`${check ? 'Checking' : 'Running'} ${run.id} (${runId})\n`);
    // Secrets come from the process environment only (spec 5).
    await runScenario(run.scenario, {
      runDir,
      baseUrl: flags.baseUrl ?? config.baseUrl,
      allowedOrigins: config.allowedOrigins,
      env: host.env,
      headless: flags.headed !== true,
      endHoldMs: check ? 0 : config.render.endHoldMs,
      record: !check,
      observers: [
        createCaptureObserver({ scenarioId: run.id, runId }),
        ...(progress ? [progressObserver(io)] : []),
      ],
    });

    // A recorded run is rendered whatever the verdict: the video of a failed
    // verification is the evidence (ADR-0004 §4). A check recorded nothing.
    let renderError: unknown;
    if (existsSync(path.join(runDir, RUN_FILES.video))) {
      io.stderr('Rendering\n');
      if (progress) emitProgress(io, { phase: 'rendering' });
      try {
        const plan = await buildRenderPlan(
          runDir,
          renderPlanOptions(config, flags.format, run.scenario.description),
        );
        await ffmpegRenderer.render(runDir, plan);
      } catch (error) {
        renderError = error;
      }
    }

    const result = await settleRun(runDir);
    if (renderError !== undefined) {
      const reason =
        renderError instanceof Error
          ? renderError.message
          : String(renderError);
      io.stderr(`rendering failed: ${reason}\n`);
    }
    return { result, runDir, renderError };
  }

  /** An ordinary run: its result as before spec 360, and its exit code. */
  function concludeRun([done]: Finished[]): number {
    if (done === undefined) return EXIT_STAGE_FAILED;
    const { result, runDir, renderError } = done;
    io.stdout(
      flags.json === true
        ? formatJson(result, runDir)
        : formatSummary(result, runDir),
    );
    const code = exitCodeFor(result);
    // A render crash before the stage was recorded must not read as success.
    return code === 0 && renderError !== undefined ? EXIT_STAGE_FAILED : code;
  }

  /** Spec 360, Decision 4: every run, then `0` when all passed, else `1`. */
  function concludeCheck(finished: Finished[]): number {
    const failed = finished.filter(
      ({ result }) => result.status === 'failed',
    ).length;
    io.stdout(
      flags.json === true
        ? formatCheckJson(finished)
        : `${finished.length - failed} passed, ${failed} failed\n`,
    );
    return failed === 0 ? 0 : EXIT_CHECK_FAILED;
  }
}

/** A check run or pass that failed: any run of it failed, whatever the stage. */
export const EXIT_CHECK_FAILED = 1;

/**
 * Spec 360, Decision 2: what a check refuses before anything runs. A check
 * renders nothing and nobody watches it.
 */
function assertCheckFlags(file: string | undefined, flags: RunFlags): void {
  if (flags.format !== undefined) {
    throw new CommandError(
      'check-flag',
      '--check renders nothing: --format cannot be used with it',
    );
  }
  if (flags.headed === true) {
    throw new CommandError(
      'check-flag',
      '--check runs headless: --headed cannot be used with it',
    );
  }
  if (file === undefined && flags.runId !== undefined) {
    throw new CommandError(
      'check-flag',
      '--run-id names one run: give a scenario, or leave --run-id out of a check pass',
    );
  }
  if (file !== undefined && (flags.exclude ?? []).length > 0) {
    throw new CommandError(
      'check-flag',
      '--exclude applies to a check pass: leave out the scenario, or --exclude',
    );
  }
}

/**
 * The scenarios of a check pass: the daemon's own listing (spec 247), sorted
 * by id, minus `--exclude`. An excluded id that is no scenario is ignored: a
 * deleted scenario must not break a schedule. An id may leave out the
 * leading `demoflow/`.
 */
async function passFiles(
  root: string,
  fragmentsDir: string | undefined,
  exclude: readonly string[],
  io: Io,
): Promise<string[]> {
  // The listing compares real paths: a Windows 8.3 root would list nothing.
  const real = await canonicalRoot(root);
  const listing = await listScenarios(real, nodeLaunchFs, fragmentsDir);
  const excluded = new Set(
    exclude.map((id) =>
      id.startsWith(SCENARIOS_PREFIX) ? id : `${SCENARIOS_PREFIX}${id}`,
    ),
  );
  if (listing.skipped > 0) {
    io.stderr(
      `warning: ${listing.skipped} scenario file(s) left out: not valid (run demoflow validate)\n`,
    );
  }
  if (listing.truncated) {
    io.stderr(
      `warning: the project has more scenarios than a check pass runs (${LIST_MAX_SCENARIOS})\n`,
    );
  }
  return listing.scenarios
    .filter((scenario) => !excluded.has(scenario.id))
    .map((scenario) => path.join(root, ...scenario.id.split('/')));
}

const SCENARIOS_PREFIX = 'demoflow/';

type Started = { app: RunningApp } | { error: unknown };

/** `--port <n>`: a decimal integer from 1 to 65535, used or not (spec 337). */
export function portFlag(text: string): number {
  const port = parsePort(text);
  if (port === undefined) {
    throw new CommandError(
      'invalid-port',
      `--port ${text}: expected an integer from 1 to 65535`,
    );
  }
  return port;
}

/**
 * `--fresh-app` (spec 337, Decision 7): any answer on `readyUrl`, 5xx
 * included, means another app holds the port. Checked before the browser
 * check, the run directory and the app start, so a refusal is fast and
 * leaves nothing behind.
 */
async function assertNoAppRunning(
  dev: ProjectConfig['devCommand'],
): Promise<void> {
  if (dev === undefined) {
    throw new CommandError(
      'fresh-app-needs-dev-command',
      `--fresh-app needs devCommand in ${PROJECT_CONFIG_FILE}: without it DemoFlow starts no app`,
    );
  }
  if (await anyAnswer(dev.readyUrl)) {
    throw new CommandError(
      'app-already-running',
      `--fresh-app: ${dev.readyUrl} already answers; another app holds this port. Stop it or pass another --port.`,
    );
  }
}

/**
 * The app never answered, so the engine never ran: the CLI writes the run's
 * `result.json` itself — readiness failed with the app's last output, the
 * other stages skipped (spec 5) — and settles it like any finished run.
 */
async function writeAppNotReady(input: {
  error: AppStartError;
  output: string[];
  scenarioName: string;
  scenarioFile: string;
  runId: string;
  runDir: string;
}): Promise<RunResult> {
  const { error, output, runDir } = input;
  const message =
    output.length === 0
      ? error.message
      : `${error.message}\nLast output of devCommand:\n${output.join('\n')}`;
  const now = new Date().toISOString();
  const skipped = { status: 'skipped' } as const;
  const pending = { status: 'pending' } as const;
  const stages: RunResult['stages'] = {
    readiness: {
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      error: { message },
    },
    execution: skipped,
    verification: skipped,
    recording: skipped,
    rendering: pending,
    storage: pending,
  };
  const unsettled: RunResult = {
    schemaVersion: 1,
    runId: input.runId,
    scenarioId: input.scenarioFile,
    scenarioName: input.scenarioName,
    startedAt: now,
    finishedAt: now,
    status: 'failed',
    stages,
    renders: [],
    warnings: [],
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, RUN_FILES.result),
    `${JSON.stringify(unsettled, null, 2)}\n`,
  );
  return settleRun(runDir);
}
