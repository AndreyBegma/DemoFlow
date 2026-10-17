import type { Issue } from '@demoflow/core';
import type { Io } from './io.ts';
import { loadScenario } from './scenario-file.ts';

function formatIssue(issue: Issue): string {
  return `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`;
}

/** `demoflow validate <scenario>`: schema check only. Input errors are thrown (exit 2). */
export function validateCommand(file: string, io: Io): number {
  const { warnings } = loadScenario(file);
  for (const warning of warnings) {
    io.stderr(`warning ${warning.code}:\n${formatIssue(warning)}\n`);
  }
  io.stdout(`${file} is valid\n`);
  return 0;
}
