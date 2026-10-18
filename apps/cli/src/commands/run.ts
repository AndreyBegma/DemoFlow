import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createCaptureObserver,
  RUN_FILES,
  runScenario,
} from '@demoflow/engine';
import { buildRenderPlan, ffmpegRenderer } from '@demoflow/renderer';
import {
  currentHost,
  findProjectRoot,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  resolveHome,
  runDir as runDirFor,
  scenarioId,
} from '../config/index.ts';
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
  /** Hidden: names the run directory so a caller knows it before the start. */
  runId?: string;
}

export interface RunDeps {
  host: HostEnvironment;
  cwd: string;
  runId: () => string;
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
  const root = findProjectRoot(file);
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
      });
      await ffmpegRenderer.render(runDir, plan);
    } catch (error) {
      renderError = error;
    }
  }

  const result = await settleRun(runDir);
  if (renderError !== undefined) {
    const reason =
      renderError instanceof Error ? renderError.message : String(renderError);
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
