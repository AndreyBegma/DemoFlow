import type { Issue } from '@demoflow/core';
import type { ShareRefusalCode } from '../share/publish.ts';

export type ToolErrorCode =
  | 'invalid-input'
  | 'both-or-neither-scenario'
  | 'project-not-found'
  | 'invalid-project-config'
  | 'invalid-scenario'
  | 'scenario-unreadable'
  | 'file-not-in-project'
  | 'task-not-found'
  // `share_demo` (spec 349, Decision 7).
  | 'share-not-allowed'
  | 'share-failed'
  | 'server-error'
  | ShareRefusalCode;

/** What an agent gets back from a failed tool call (spec #68, Decision 9). */
export interface ToolErrorPayload {
  code: ToolErrorCode;
  message: string;
  hint: string;
  /** Validation issues, addressed by path: `steps[3].target`. */
  issues?: { path: string; message: string }[];
}

/** A tool call the server refuses; turned into `{ code, message, hint }`. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint: string;
  readonly issues: Issue[];

  constructor(
    code: ToolErrorCode,
    message: string,
    hint: string,
    issues: Issue[] = [],
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
    this.issues = issues;
  }

  toPayload(): ToolErrorPayload {
    const payload: ToolErrorPayload = {
      code: this.code,
      message: this.message,
      hint: this.hint,
    };
    if (this.issues.length > 0) {
      payload.issues = this.issues.map((issue) => ({
        path: issue.path === '' ? '(root)' : issue.path,
        message: issue.message,
      }));
    }
    return payload;
  }
}
