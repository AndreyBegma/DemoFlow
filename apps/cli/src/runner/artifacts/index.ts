import { lstat, readFile, rm } from 'node:fs/promises';
import { RunResultSchema } from '@demoflow/core';
import { pathFor } from '../../config/platform.ts';
import { findReportedRun } from '../../runs-report/reported-runs.ts';
import type { Logger } from '../log.ts';
import { RUN_ID } from '../relay/index.ts';

/** `RUN_FILES.result` of the engine, which the daemon does not load. */
const RESULT_FILE = 'result.json';
/** ADR-0004 §7: a run lives at `<home>/runs/<runId>/`. */
const RUNS_DIR = 'runs';

/** The filesystem the deleter touches; tests inject failures into `rm`. */
export interface ArtifactsFs {
  lstat(
    file: string,
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readFile(file: string): Promise<string>;
  rm(dir: string): Promise<void>;
}

export const nodeArtifactsFs: ArtifactsFs = {
  lstat: (file) => lstat(file),
  readFile: (file) => readFile(file, 'utf8'),
  // Node removes a symlink inside the directory as a link, never its target.
  rm: (dir) => rm(dir, { recursive: true }),
};

export interface ArtifactsDeps {
  /** `reported-runs.jsonl`. */
  indexFile: string;
  fs: ArtifactsFs;
  logger: Logger;
  platform: NodeJS.Platform;
  /** The user's home directory, which is never removed. */
  homeDir: string;
  /** Decision 4: ends the run's open video streams and releases their files. */
  closeRun(runId: string): Promise<void>;
}

/** The socket, as the deleter sees it: JSON text frames only. */
export interface ArtifactsSender {
  send(message: Record<string, unknown>): void;
}

/** What the connection needs from the deleter. */
export interface ArtifactsPort {
  handle(message: Record<string, unknown>, sender: ArtifactsSender): void;
}

/**
 * Decision 8: what `runner.log` says. `refused` is a boundary refusal, which
 * the API hears as `not-found`.
 */
export type DeleteOutcome =
  | 'deleted'
  | 'already-gone'
  | 'not-found'
  | 'refused'
  | 'io';

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * Decision 3: the run directory a line of the index names, resolved, if its
 * path alone can be a DemoFlow run directory; otherwise `null`.
 */
export function candidateRunDir(
  runDir: string,
  homeDir: string,
  platform: NodeJS.Platform,
): string | null {
  const p = pathFor(platform);
  if (!p.isAbsolute(runDir)) return null;
  const resolved = p.resolve(runDir);
  const fold = (value: string) =>
    platform === 'win32' ? value.toLowerCase() : value;
  const parent = p.dirname(resolved);
  if (
    parent === resolved ||
    fold(resolved) === fold(p.resolve(homeDir)) ||
    fold(p.basename(resolved)) === RUNS_DIR ||
    fold(p.basename(parent)) !== RUNS_DIR
  ) {
    return null;
  }
  return resolved;
}

/**
 * Spec 234: the daemon's side of `artifacts.delete`. It removes a reported
 * run's directory, and only one that is exactly a DemoFlow run directory.
 * The server names a run by its id; no path is ever sent or logged.
 */
export class ArtifactsDeleter implements ArtifactsPort {
  private readonly deps: ArtifactsDeps;
  /** Decision 6: the deletion in progress for each server run id. */
  private readonly running = new Map<string, Promise<DeleteOutcome>>();

  constructor(deps: ArtifactsDeps) {
    this.deps = deps;
  }

  handle(message: Record<string, unknown>, sender: ArtifactsSender): void {
    const { requestId, runId } = message;
    if (
      typeof requestId !== 'string' ||
      typeof runId !== 'string' ||
      !RUN_ID.test(runId)
    ) {
      this.deps.logger.log('warn', 'ignored a malformed artifacts.delete');
      return;
    }
    void this.delete(runId).then((outcome) => {
      this.deps.logger.log('info', `artifacts ${runId}: ${outcome}`);
      if (outcome === 'deleted' || outcome === 'already-gone') {
        sender.send({ type: 'artifacts.deleted', requestId });
      } else {
        sender.send({
          type: 'artifacts.error',
          requestId,
          code: outcome === 'io' ? 'io' : 'not-found',
        });
      }
    });
  }

  /** Resolves with the outcome; a request for a run already being deleted shares it. */
  delete(runId: string): Promise<DeleteOutcome> {
    const pending = this.running.get(runId);
    if (pending !== undefined) return pending;
    const deletion = this.run(runId)
      .catch((): DeleteOutcome => 'io')
      .finally(() => {
        this.running.delete(runId);
      });
    this.running.set(runId, deletion);
    return deletion;
  }

  private async run(runId: string): Promise<DeleteOutcome> {
    const { fs, platform } = this.deps;
    const entry = await findReportedRun(this.deps.indexFile, runId);
    if (entry === null) return 'not-found';
    const runDir = candidateRunDir(entry.runDir, this.deps.homeDir, platform);
    if (runDir === null) return 'refused';
    try {
      const stats = await fs.lstat(runDir);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return 'refused';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'already-gone' : 'io';
    }
    if (!(await this.holdsItsRun(runDir))) return 'refused';
    await this.deps.closeRun(runId);
    try {
      await fs.rm(runDir);
    } catch (error) {
      // Whatever was removed stays removed; a retry finishes the job.
      if (errorCode(error) !== 'ENOENT') return 'io';
    }
    return 'deleted';
  }

  /** `result.json` parses and names the directory it lives in. */
  private async holdsItsRun(runDir: string): Promise<boolean> {
    const p = pathFor(this.deps.platform);
    try {
      const parsed = RunResultSchema.safeParse(
        JSON.parse(await this.deps.fs.readFile(p.join(runDir, RESULT_FILE))),
      );
      return parsed.success && parsed.data.runId === p.basename(runDir);
    } catch {
      return false;
    }
  }
}
