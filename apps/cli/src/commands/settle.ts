import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deriveRunStatus,
  type RunResult,
  RunResultSchema,
} from '@demoflow/core';

const RESULT_FILE = 'result.json';

export async function readResult(runDir: string): Promise<RunResult> {
  return RunResultSchema.parse(
    JSON.parse(await readFile(path.join(runDir, RESULT_FILE), 'utf8')),
  );
}

/**
 * Closes the stages the CLI owns. `storage` belongs to the run as a whole and
 * Phase 1 has none (local only, ADR-0008), so it is `skipped`; `rendering` is
 * `skipped` when nothing was rendered. The status is derived again and the
 * file replaced atomically. Phase 2 (cloud storage) replaces `storage: skipped`.
 */
export async function settleRun(runDir: string): Promise<RunResult> {
  const result = await readResult(runDir);
  if (result.stages.rendering.status === 'pending') {
    result.stages.rendering = { status: 'skipped' };
  }
  if (result.stages.storage.status === 'pending') {
    result.stages.storage = { status: 'skipped' };
  }
  result.status = deriveRunStatus(result.stages, result.warnings);
  const valid = RunResultSchema.parse(result);

  const file = path.join(runDir, RESULT_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`);
  await rename(temporary, file);
  return valid;
}
