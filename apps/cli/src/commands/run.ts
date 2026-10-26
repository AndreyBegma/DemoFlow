import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ProjectConfig,
  parsePort,
  type RenderFormat,
  type RunResult,
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
  projectRootAt,
  resolveHome,
  runDir as runDirFor,
  scenarioId,
} from '../config/index.ts';
import {
  defaultReportDeps,
  type ReportDeps,
  reportRun,
} from '../runs-report/report.ts';
import { type BrowserDeps, ensureChromium } from './browser.ts';
import { CommandError, EXIT_STAGE_FAILED } from './errors.ts';
import { exitCodeFor } from './exit.ts';
import type { Io } from './io.ts';
import { formatJson, formatSummary } from './output.ts';
import { emitProgress, progressObserver } from './progress.ts';
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
}

export interface RunDeps {
  host: HostEnvironment;
  cwd: string;
  runId: () => string;
  /** Chromium's check and first-use install; Playwright's own by default. */
  browser?: BrowserDeps;
  /** The report to the server after the run; the real one by default. */
  report?: ReportDeps;
}

export function defaultRunDeps(): RunDeps {
  return { host: currentHost(), cwd: process.cwd(), runId: generateRunId };
}

/**
 * `demoflow run <scenario>`: validate, load the config, resolve the home, run
 * the engine, render, print. Input errors are thrown (exit 2); a finished run
 * returns its exit code.
 */
export async function runCommand(
  file: string,
  flags: RunFlags,
  io: Io,
  deps: RunDeps = defaultRunDeps(),
): Promise<number> {
  const { host } = deps;
  const port = flags.port === undefined ? undefined : portFlag(flags.port);
  const root =
    flags.project === undefined
      ? findProjectRoot(file)
      : projectRootAt(path.resolve(deps.cwd, flags.project));
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
  const { scenario, warnings } = loadScenario(
    file,
    projectFragments(root, config.fragmentsDir),
  );
  for (const warning of warnings) {
    io.stderr(`warning ${warning.path}: ${warning.message}\n`);
  }

  const runId = flags.runId ?? deps.runId();
  if (flags.runId !== undefined) assertSafeRunId(flags.runId);
  const runDir = runDirFor(home, runId, host.platform);
  if (flags.runId !== undefined && existsSync(runDir)) {
    throw new CommandError(
      'invalid-run-id',
      `run directory already exists: ${runDir}`,
    );
  }
  const fresh = flags.freshApp === true;
  if (fresh) await assertNoAppRunning(config.devCommand);
  // After every input check: a bad scenario never costs a browser download
  // or an app start. The start overlaps with the download; the app's output
  // is kept and shown only if the start fails.
  const progress = flags.progress === true;
  if (progress) emitProgress(io, { phase: 'app' });
  const tail = outputTail();
  const starting: Promise<Started> = startApp(config, root, {
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
    if ('error' in started) {
      if (!(started.error instanceof AppStartError)) throw started.error;
      return await reportAppNotReady({
        error: started.error,
        output: tail.lines(),
        scenarioName: scenario.name,
        scenarioFile: scenarioId(root, file),
        runId,
        runDir,
        json: flags.json === true,
        io,
      });
    }
    return await execute();
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await stopApp();
  }

  async function execute(): Promise<number> {
    io.stderr(`Running ${scenarioId(root, file)} (${runId})\n`);
    // Secrets come from the process environment only (spec 5).
    await runScenario(scenario, {
      runDir,
      baseUrl: flags.baseUrl ?? config.baseUrl,
      allowedOrigins: config.allowedOrigins,
      env: host.env,
      headless: flags.headed !== true,
      endHoldMs: config.render.endHoldMs,
      observers: [
        createCaptureObserver({ scenarioId: scenarioId(root, file), runId }),
        ...(progress ? [progressObserver(io)] : []),
      ],
    });

    // A recorded run is rendered whatever the verdict: the video of a failed
    // verification is the evidence (ADR-0004 §4).
    let renderError: unknown;
    if (existsSync(path.join(runDir, RUN_FILES.video))) {
      io.stderr('Rendering\n');
      if (progress) emitProgress(io, { phase: 'rendering' });
      try {
        const plan = await buildRenderPlan(
          runDir,
          renderPlanOptions(config, flags.format, scenario.description),
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
    io.stdout(
      flags.json === true
        ? formatJson(result, runDir)
        : formatSummary(result, runDir),
    );
    await reportRun(
      { root, runDir, result },
      deps.report ?? defaultReportDeps(host),
    );
    const code = exitCodeFor(result);
    // A render crash before the stage was recorded must not read as success.
    return code === 0 && renderError !== undefined ? EXIT_STAGE_FAILED : code;
  }
}

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
 * other stages skipped (spec 5) — and prints it like any finished run.
 */
async function reportAppNotReady(input: {
  error: AppStartError;
  output: string[];
  scenarioName: string;
  scenarioFile: string;
  runId: string;
  runDir: string;
  json: boolean;
  io: Io;
}): Promise<number> {
  const { error, output, runDir, io } = input;
  const message =
    output.length === 0
      ? error.message
      : `${error.message}\nLast output of devCommand:\n${output.join('\n')}`;
  if (output.length > 0) io.stderr(`${output.join('\n')}\n`);
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
  const result = await settleRun(runDir);
  io.stdout(
    input.json ? formatJson(result, runDir) : formatSummary(result, runDir),
  );
  return exitCodeFor(result);
}
