import type { Issue } from '@demoflow/core';
import { CliError, EXIT_INVALID_INPUT } from '../config/index.ts';

export type CommandErrorCode =
  | 'scenario-unreadable'
  | 'invalid-scenario'
  | 'invalid-run-id'
  | 'invalid-limit'
  | 'invalid-duration'
  | 'prune-needs-a-filter'
  | 'run-not-found'
  | 'invalid-result'
  | 'run-unfinished'
  | 'no-recording'
  | 'invalid-port'
  | 'app-already-running'
  | 'fresh-app-needs-dev-command'
  | 'missing-scenario'
  | 'check-flag';

/** Bad input to a command (spec 5: exit 2) that is not a config problem. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly exitCode = EXIT_INVALID_INPUT;
  readonly issues: Issue[];

  constructor(code: CommandErrorCode, message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.issues = issues;
  }
}

/** Exit code `3`: a stage after execution failed outside the scenario's control. */
export const EXIT_STAGE_FAILED = 3;

export function isInputError(error: unknown): error is CliError | CommandError {
  return error instanceof CliError || error instanceof CommandError;
}

export function describeError(error: CliError | CommandError): string {
  const lines = [`${error.code}: ${error.message}`];
  for (const issue of error.issues) {
    lines.push(
      `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`,
    );
  }
  return lines.join('\n');
}
