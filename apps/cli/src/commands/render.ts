import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  ProjectConfig,
  RenderFormat,
  RunResult,
  StageStatus,
} from '@demoflow/core';
import { RUN_FILES } from '@demoflow/engine';
import {
  buildRenderPlan,
  ffmpegRenderer,
  type Renderer,
  type RenderPlanOptions,
} from '@demoflow/renderer';
import {
  currentHost,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  projectRootAbove,
  projectRootAt,
  resolveHome,
  runDir as runDirFor,
} from '../config/index.ts';
import { CommandError, EXIT_STAGE_FAILED } from './errors.ts';
import { exitCodeFor } from './exit.ts';
import type { Io } from './io.ts';
import { formatJson, formatSummary } from './output.ts';
import { assertSafeRunId } from './run-id.ts';
import { loadScenario } from './scenario-file.ts';
import { readResult, settleRun } from './settle.ts';

export interface RenderFlags {
  out?: string;
  json?: boolean;
  /** `--format`: replaces `render.formats` for this render. */
  format?: RenderFormat[];
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface RenderDeps {
  host: HostEnvironment;
  cwd: string;
  buildPlan: typeof buildRenderPlan;
  renderer: Renderer;
}

export function defaultRenderDeps(): RenderDeps {
  return {
    host: currentHost(),
    cwd: process.cwd(),
    buildPlan: buildRenderPlan,
    renderer: ffmpegRenderer,
  };
}

/** The capture stages: a render needs every one of them finished. */
const CAPTURE_STAGES = [
  'readiness',
  'execution',
  'verification',
  'recording',
] as const;

const UNFINISHED: readonly StageStatus[] = ['pending', 'running'];

/**
 * `demoflow render <runId>` (spec 255): render an existing run directory again
 * with the project's current `render.*`. Only `renders[]` and the `rendering`
 * stage change, so the verdict never does (ADR-0004 §4). Input errors are
 * thrown (exit 2) before anything is written; the website is not told.
 */
export async function renderCommand(
  runId: string,
  flags: RenderFlags,
  io: Io,
  deps: RenderDeps = defaultRenderDeps(),
): Promise<number> {
  const { host } = deps;
  assertSafeRunId(runId);
  const root =
    flags.project === undefined
      ? projectRootAbove(deps.cwd)
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
  const runDir = runDirFor(home, runId, host.platform);
  const result = await readRenderable(runDir);

  io.stderr('Rendering\n');
  let renderError: unknown;
  try {
    const plan = await deps.buildPlan(
      runDir,
      renderPlanOptions(
        config,
        flags.format,
        scenarioDescription(root, result.scenarioId),
      ),
    );
    await deps.renderer.render(runDir, plan);
  } catch (error) {
    renderError = error;
  }

  const settled = await settleRun(runDir);
  if (renderError !== undefined) {
    const reason =
      renderError instanceof Error ? renderError.message : String(renderError);
    io.stderr(`rendering failed: ${reason}\n`);
  }
  io.stdout(
    flags.json === true
      ? formatJson(settled, runDir)
      : formatSummary(settled, runDir),
  );
  const code = exitCodeFor(settled);
  // A failure before the renderer recorded the stage must not read as success.
  return code === 0 && renderError !== undefined ? EXIT_STAGE_FAILED : code;
}

/**
 * The run's `result.json`, if the run can be rendered: the directory exists,
 * the result is valid, the capture stages are finished and the source video
 * was recorded. A `rendering` stage left `running` by a crash is accepted —
 * retrying it is what the command is for.
 */
async function readRenderable(runDir: string): Promise<RunResult> {
  if (!existsSync(runDir)) {
    throw new CommandError('run-not-found', `no run directory at ${runDir}`);
  }
  let result: RunResult;
  try {
    result = await readResult(runDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      'invalid-result',
      `cannot read ${path.join(runDir, RUN_FILES.result)}: ${reason}`,
    );
  }
  const unfinished = CAPTURE_STAGES.filter((stage) =>
    UNFINISHED.includes(result.stages[stage].status),
  );
  if (unfinished.length > 0) {
    throw new CommandError(
      'run-unfinished',
      `the run is not finished: ${unfinished
        .map((stage) => `${stage} is ${result.stages[stage].status}`)
        .join(', ')}`,
    );
  }
  if (result.stages.recording.status !== 'passed') {
    throw new CommandError(
      'no-recording',
      `the run has no recording: recording is ${result.stages.recording.status}`,
    );
  }
  if (!existsSync(path.join(runDir, RUN_FILES.video))) {
    throw new CommandError(
      'no-recording',
      `the run has no source video: ${path.join(runDir, RUN_FILES.video)} is missing`,
    );
  }
  return result;
}

/**
 * The intro card's subtitle: the scenario's `description`, read from the
 * project when its file is still there and loads. An inline scenario of
 * `demoflow mcp` is gone after its run, so its card has no subtitle.
 */
function scenarioDescription(
  root: string,
  scenarioId: string,
): string | undefined {
  const file = path.join(root, scenarioId);
  if (!existsSync(file)) return undefined;
  try {
    return loadScenario(file).scenario.description;
  } catch {
    return undefined;
  }
}

/**
 * What `buildRenderPlan` gets from the project's `render.*`, for `run` and
 * `render` alike: a re-render is styled exactly like a first render would be
 * today (spec 255, Decision 3).
 */
export function renderPlanOptions(
  config: ProjectConfig,
  formats: RenderFormat[] | undefined,
  description: string | undefined,
): RenderPlanOptions {
  return {
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
    formats: formats ?? config.render.formats,
    gif: config.render.gif,
    vertical: config.render.vertical,
    scenario: description === undefined ? {} : { description },
  };
}
