import path from 'node:path';
import { type RunResult, STAGE_NAMES } from '@demoflow/core';

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
    const detail = stage.error === undefined ? '' : `  ${stage.error.message}`;
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
