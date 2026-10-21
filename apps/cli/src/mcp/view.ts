import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type RenderFormat,
  type RenderOutput,
  type RunResult,
  STAGE_NAMES,
  type Stages,
} from '@demoflow/core';
import { RUN_FILES } from '@demoflow/engine';
import type { TaskStatus } from './tasks.ts';

/** `get_task`'s output; paths are absolute local paths (ADR-0008 §1). */
export interface TaskView {
  taskId: string;
  status: TaskStatus;
  /** Tasks ahead of a queued one. */
  position?: number;
  /** Why it failed when there is no `result.json` to say it. */
  message?: string;
  stages?: Stages;
  failedStep?: { stepIndex: number; message: string };
  artifacts?: {
    /** The first of `videos`. */
    video?: string;
    /** Every rendered file on disk, in `render.formats` order (spec 133). */
    videos?: RenderedVideo[];
    timeline?: string;
    source?: string;
    runDir: string;
  };
}

/** One rendered file, as an absolute local path. */
export interface RenderedVideo {
  format: RenderFormat;
  path: string;
}

/** The renders of a run that are on disk, in the order `result.json` lists them. */
export function renderedVideos(
  runDir: string,
  renders: readonly RenderOutput[],
): RenderedVideo[] {
  return renders.flatMap(({ format, file }) => {
    const video = path.join(runDir, ...file.split('/'));
    return existsSync(video) ? [{ format, path: video }] : [];
  });
}

export function taskView(input: {
  taskId: string;
  status: TaskStatus;
  runDir: string;
  result?: RunResult;
  position?: number;
  message?: string;
}): TaskView {
  const { taskId, status, runDir, result } = input;
  const view: TaskView = { taskId, status };
  if (input.position !== undefined) view.position = input.position;
  if (input.message !== undefined) view.message = input.message;
  if (result !== undefined) {
    view.stages = result.stages;
    const failedStep = failedStepOf(result.stages);
    if (failedStep !== undefined) view.failedStep = failedStep;
  }
  if (status !== 'queued' && existsSync(runDir)) {
    view.artifacts = artifactsOf(runDir, result);
  }
  return view;
}

/** The first stage, in pipeline order, whose error names a step. */
function failedStepOf(
  stages: Stages,
): { stepIndex: number; message: string } | undefined {
  for (const name of STAGE_NAMES) {
    const error = stages[name].error;
    if (error?.stepIndex !== undefined) {
      return { stepIndex: error.stepIndex, message: error.message };
    }
  }
  return undefined;
}

function artifactsOf(
  runDir: string,
  result: RunResult | undefined,
): NonNullable<TaskView['artifacts']> {
  const artifacts: NonNullable<TaskView['artifacts']> = { runDir };
  const videos = renderedVideos(runDir, result?.renders ?? []);
  if (videos.length > 0) {
    artifacts.video = videos[0].path;
    artifacts.videos = videos;
  }
  const timeline = path.join(runDir, RUN_FILES.timeline);
  if (existsSync(timeline)) artifacts.timeline = timeline;
  const source = path.join(runDir, RUN_FILES.video);
  if (existsSync(source)) artifacts.source = source;
  return artifacts;
}
