import type { Issue } from '@demoflow/core';

/** Exit codes of spec 5: `2` invalid input, `3` any other stage failed. */
export type CliErrorCode =
  | 'no-project-config'
  | 'invalid-config'
  | 'invalid-global-config';

export const EXIT_INVALID_INPUT = 2;

/** An error the CLI turns into an exit code; config errors are always exit 2. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly issues: Issue[];

  constructor(
    code: CliErrorCode,
    message: string,
    issues: Issue[] = [],
    exitCode: number = EXIT_INVALID_INPUT,
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.issues = issues;
  }
}
