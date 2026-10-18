import { existsSync } from 'node:fs';
import path from 'node:path';
import { type RunResult, STAGE_NAMES, type Stages } from '@demoflow/core';
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
    video?: string;
    timeline?: string;
    source?: string;
    runDir: string;
  };
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
  const render = result?.renders[0];
  const video =
    render === undefined
      ? undefined
      : path.join(runDir, ...render.file.split('/'));
  if (video !== undefined && existsSync(video)) artifacts.video = video;
  const timeline = path.join(runDir, RUN_FILES.timeline);
  if (existsSync(timeline)) artifacts.timeline = timeline;
  const source = path.join(runDir, RUN_FILES.video);
  if (existsSync(source)) artifacts.source = source;
  return artifacts;
}
