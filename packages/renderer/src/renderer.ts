import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deriveRunStatus,
  type RenderOutput,
  type RunResult,
  RunResultSchema,
  type Stage,
} from '@demoflow/core';
import { probeVideo } from './plan/ffmpeg.ts';
import { PLAN_INPUTS } from './plan/plan.ts';
import type { RenderPlan } from './plan/types.ts';

/**
 * Draws a render plan into an MP4 (spec 4). An implementation writes `out`
 * through `recordRender`, which keeps `result.json` in step.
 */
export interface Renderer {
  /** `ffmpeg`; names the file `render/<name>.mp4` and the `renders[]` entry. */
  readonly name: string;
  /**
   * Renders `plan` — built by `buildRenderPlan(runDir)` — to `out`, which
   * defaults to `renderPath(runDir, name)`. Resolves with the entry it added
   * to `renders[]`; rejects after marking the `rendering` stage failed.
   */
  render(runDir: string, plan: RenderPlan, out?: string): Promise<RenderOutput>;
}

/** `<runDir>/render/<renderer>.mp4` */
export function renderPath(runDir: string, renderer: string): string {
  return path.join(runDir, 'render', `${renderer}.mp4`);
}

/**
 * Runs `draw`, which writes the MP4 at `file`, and records it in the run's
 * `result.json`: the `rendering` stage goes `running` → `passed` (or `failed`
 * with the error, which is rethrown), the MP4 is probed, its `renders[]` entry
 * replaces any earlier one of the same renderer, and the run status is
 * derived again (ADR-0004 §3).
 */
export async function recordRender(
  runDir: string,
  renderer: string,
  file: string,
  draw: () => Promise<void>,
): Promise<RenderOutput> {
  await updateResult(runDir, (result) => {
    result.stages.rendering = { status: 'running', startedAt: timestamp() };
  });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await draw();
    const probe = await probeVideo(file);
    const output: RenderOutput = {
      renderer,
      // Run-relative and `/`-separated on every platform: it goes into JSON.
      file: path.relative(runDir, file).split(path.sep).join('/'),
      durationMs: Math.round(probe.durationMs),
      sizeBytes: (await stat(file)).size,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
    };
    await updateResult(runDir, (result) => {
      result.renders = [
        ...result.renders.filter((entry) => entry.renderer !== renderer),
        output,
      ];
      result.stages.rendering = finish(result.stages.rendering, 'passed');
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateResult(runDir, (result) => {
      result.stages.rendering = finish(result.stages.rendering, 'failed', {
        message,
      });
    });
    throw error;
  }
}

/** Updates of one `result.json` run one after another, never interleaved. */
const queues = new Map<string, Promise<unknown>>();

function updateResult(
  runDir: string,
  change: (result: RunResult) => void,
): Promise<void> {
  const file = path.resolve(runDir, PLAN_INPUTS.result);
  const run = async (): Promise<void> => {
    const result = RunResultSchema.parse(
      JSON.parse(await readFile(file, 'utf8')),
    );
    change(result);
    result.status = deriveRunStatus(result.stages, result.warnings);
    const valid = RunResultSchema.parse(result);
    // Write beside it and rename: a reader never sees half a file.
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`);
    await rename(temporary, file);
  };
  const next = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

function finish(
  stage: Stage,
  status: 'passed' | 'failed',
  error?: Stage['error'],
): Stage {
  return {
    ...stage,
    status,
    finishedAt: timestamp(),
    ...(error === undefined ? {} : { error }),
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
