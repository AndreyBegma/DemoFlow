import type { Runner, User } from '@prisma/client';
import type { Request } from 'express';

/** Makes a leaked device token recognisable to secret scanners (ADR-0007). */
export const RUNNER_TOKEN_PREFIX = 'dfr_';

/** What `RunnerTokenGuard` attaches to a request it lets through. */
export interface RunnerContext {
  runner: Runner;
  user: User;
}

export interface RunnerRequest extends Request {
  runnerAuth?: RunnerContext;
}
