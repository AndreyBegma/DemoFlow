import type { RunResult } from '@demoflow/core';
import { EXIT_INVALID_INPUT } from '../config/index.ts';
import { EXIT_STAGE_FAILED } from './errors.ts';

/**
 * Spec 5 exit codes from a finished run: `0` completed (with or without
 * warnings), `2` readiness failed (invalid input), `1` execution or
 * verification failed, `3` any other stage failed. The first failure in
 * pipeline order decides.
 */
export function exitCodeFor(result: Pick<RunResult, 'stages'>): number {
  const { stages } = result;
  if (stages.readiness.status === 'failed') return EXIT_INVALID_INPUT;
  if (
    stages.execution.status === 'failed' ||
    stages.verification.status === 'failed'
  ) {
    return 1;
  }
  const others = [stages.recording, stages.rendering, stages.storage];
  if (others.some((stage) => stage.status === 'failed')) {
    return EXIT_STAGE_FAILED;
  }
  return 0;
}
