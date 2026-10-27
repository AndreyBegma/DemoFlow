import path from 'node:path';
import { type RunResult, STAGE_NAMES, type Stage } from '@demoflow/core';

/** `--json`: the final `result.json` plus `runDir`, as one object. */
export function formatJson(result: RunResult, runDir: string): string {
  return `${JSON.stringify({ ...result, runDir })}\n`;
}

/** The short summary for a person: stage statuses, video paths, run directory. */
export function formatSummary(result: RunResult, runDir: string): string {
  const lines = [`Run ${result.runId}: ${result.status}`];
  const width = Math.max(...STAGE_NAMES.map((name) => name.length));
  for (const name of STAGE_NAMES) {
    const stage = result.stages[name];
    const detail =
      stage.error === undefined
        ? ''
        : `  ${failedStep(stage.error)}${stage.error.message}`;
    lines.push(`  ${name.padEnd(width)}  ${stage.status}${detail}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const render of result.renders) {
    lines.push(
      `Video (${render.format}): ${path.join(runDir, ...render.file.split('/'))}`,
    );
  }
  lines.push(`Run directory: ${runDir}`);
  return `${lines.join('\n')}\n`;
}

/**
 * `step 4 (repeat steps[1], iteration 3): `: the step and `steps[n]` are
 * 0-based like `result.json`, the iteration 1-based like `{{index}}`.
 */
function failedStep(error: NonNullable<Stage['error']>): string {
  if (error.stepIndex === undefined) return '';
  const origin =
    error.origin === undefined
      ? ''
      : ` (repeat steps[${error.origin.repeatIndex}], iteration ${error.origin.iteration + 1})`;
  return `step ${error.stepIndex}${origin}: `;
}

/**
 * One line per scenario of a check (spec 360, Decision 4): its verdict, its
 * id and, when it failed, the first failed stage with its error.
 */
export function formatCheckLine(result: RunResult): string {
  const verdict = result.status === 'failed' ? 'failed' : 'passed';
  const line = `${verdict}  ${result.scenarioId}`;
  if (result.status !== 'failed') return `${line}\n`;
  const failed = STAGE_NAMES.find(
    (name) => result.stages[name].status === 'failed',
  );
  if (failed === undefined) return `${line}\n`;
  const { error } = result.stages[failed];
  const detail =
    error === undefined
      ? ''
      : ` ${failedStep(error)}${firstLine(error.message)}`;
  return `${line}  ${failed}:${detail}\n`;
}

/** `--check --json`: every run of the check, each with its `runDir`. */
export function formatCheckJson(
  runs: readonly { result: RunResult; runDir: string }[],
): string {
  const failed = runs.filter(({ result }) => result.status === 'failed').length;
  return `${JSON.stringify({
    check: true,
    passed: runs.length - failed,
    failed,
    runs: runs.map(({ result, runDir }) => ({ ...result, runDir })),
  })}\n`;
}

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}
