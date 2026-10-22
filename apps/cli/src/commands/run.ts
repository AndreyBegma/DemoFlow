import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RenderFormat, RunResult } from '@demoflow/core';
import {
  createCaptureObserver,
  RUN_FILES,
  runScenario,
} from '@demoflow/engine';
import { buildRenderPlan, ffmpegRenderer } from '@demoflow/renderer';
import { AppStartError, type RunningApp, startApp } from '../app/dev-server.ts';
import { outputTail } from '../app/output-tail.ts';
import {
  currentHost,
  findProjectRoot,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  projectRootAt,
  resolveHome,
  runDir as runDirFor,
  scenarioId,
} from '../config/index.ts';
import { type BrowserDeps, ensureChromium } from './browser.ts';
import { CommandError, EXIT_STAGE_FAILED } from './errors.ts';
import { exitCodeFor } from './exit.ts';
import type { Io } from './io.ts';
import { formatJson, formatSummary } from './output.ts';
import { assertSafeRunId, generateRunId } from './run-id.ts';
import { loadScenario } from './scenario-file.ts';
import { settleRun } from './settle.ts';

export interface RunFlags {
  baseUrl?: string;
  out?: string;
  headed?: boolean;
  json?: boolean;
  /** `--format`: replaces `render.formats` for this run (spec 133). */
  format?: RenderFormat[];
  /** Hidden: names the run directory so a caller knows it before the start. */
  runId?: string;
  /** Hidden: the project root, for a scenario file kept outside it (`demoflow mcp`). */
  project?: string;
}

export interface RunDeps {
  host: HostEnvironment;
  cwd: string;
  runId: () => string;
  /** Chromium's check and first-use install; Playwright's own by default. */
  browser?: BrowserDeps;
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
  const root =
    flags.project === undefined
      ? findProjectRoot(file)
      : projectRootAt(path.resolve(deps.cwd, flags.project));
  const config = loadProjectConfig(root);
  const { home } = resolveHome({
    ...host,
    out: flags.out,
    cwd: deps.cwd,
    projectRoot: root,
    projectConfig: config,
    globalConfig: loadGlobalConfig(host),
  });
  const { scenario, warnings } = loadScenario(file);
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
  // After every input check: a bad scenario never costs a browser download
  // or an app start. The start overlaps with the download; the app's output
  // is kept and shown only if the start fails.
  const tail = outputTail();
  const starting: Promise<Started> = startApp(config, root, {
    log: (text) => tail.push(text),
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
      observers: [
        createCaptureObserver({ scenarioId: scenarioId(root, file), runId }),
      ],
    });

    // A recorded run is rendered whatever the verdict: the video of a failed
    // verification is the evidence (ADR-0004 §4).
    let renderError: unknown;
    if (existsSync(path.join(runDir, RUN_FILES.video))) {
      io.stderr('Rendering\n');
      try {
        const plan = await buildRenderPlan(runDir, {
          idle: config.render.idle,
          output: {
            width: config.render.width,
            height: config.render.height,
            fps: config.render.fps,
          },
          frame: config.render.frame,
          background: config.render.background,
          cards: config.render.cards,
          transitions: config.render.transitions,
          formats: flags.format ?? config.render.formats,
          gif: config.render.gif,
          vertical: config.render.vertical,
          scenario:
            scenario.description === undefined
              ? {}
              : { description: scenario.description },
        });
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
    const code = exitCodeFor(result);
    // A render crash before the stage was recorded must not read as success.
    return code === 0 && renderError !== undefined ? EXIT_STAGE_FAILED : code;
  }
}

type Started = { app: RunningApp } | { error: unknown };

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
