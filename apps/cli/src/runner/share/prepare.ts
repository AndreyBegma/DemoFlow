import { readFile, realpath } from 'node:fs/promises';
import {
  type Chapter,
  RENDER_FORMATS,
  type RenderFormat,
  RunResultSchema,
} from '@demoflow/core';
import { scenarioDescription } from '../../commands/scenario-file.ts';
import { pathFor } from '../../config/platform.ts';
import { findReportedRun } from '../../runs-report/reported-runs.ts';
import type { Logger } from '../log.ts';
import { isInside, RUN_ID } from '../relay/index.ts';
import { posterPath } from './files.ts';
import { makePoster, type PosterRequest } from './poster.ts';

/** `RUN_FILES.result` of the engine, which the daemon does not load. */
const RESULT_FILE = 'result.json';
/** #347: the API keeps at most this much of a share's description. */
export const DESCRIPTION_MAX_LENGTH = 2000;

export interface ShareDeps {
  /** `reported-runs.jsonl`. */
  indexFile: string;
  logger: Logger;
  platform: NodeJS.Platform;
  /** Decision 3; tests stub FFmpeg through it. */
  makePoster(request: PosterRequest): Promise<number>;
}

/** The socket, as the preparer sees it: JSON text frames only. */
export interface ShareSender {
  send(message: Record<string, unknown>): void;
}

/** What the connection needs from the preparer. */
export interface SharePort {
  handle(message: Record<string, unknown>, sender: ShareSender): void;
}

/** What `share.prepare` answers, before the request id is added. */
export type Prepared =
  | {
      ok: true;
      description?: string;
      chapters: Chapter[];
      posterSize: number;
    }
  | { ok: false; code: 'not-found' | 'no-render' | 'io' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Spec 349, Decision 2: the daemon's side of `share.prepare`. It answers with
 * the scenario's description, the render's chapters and the size of a poster
 * it makes, which the relay then serves as `asset: 'poster'`. The server names
 * a run by its id; no path is ever sent or logged.
 */
export class SharePreparer implements SharePort {
  private readonly deps: ShareDeps;
  /** One poster at a time per file: two shares of a render share it. */
  private readonly posters = new Map<string, Promise<number>>();

  constructor(deps: ShareDeps) {
    this.deps = deps;
  }

  handle(message: Record<string, unknown>, sender: ShareSender): void {
    const { requestId, runId, format } = message;
    if (
      typeof requestId !== 'string' ||
      !UUID.test(requestId) ||
      typeof runId !== 'string' ||
      !RUN_ID.test(runId) ||
      !RENDER_FORMATS.includes(format as RenderFormat)
    ) {
      this.deps.logger.log('warn', 'ignored a malformed share.prepare');
      return;
    }
    void this.prepare(runId, format as RenderFormat)
      .catch((): Prepared => ({ ok: false, code: 'io' }))
      .then((prepared) => {
        this.deps.logger.log(
          'info',
          `share ${runId} ${format}: ${prepared.ok ? 'prepared' : prepared.code}`,
        );
        if (!prepared.ok) {
          sender.send({ type: 'share.error', requestId, code: prepared.code });
          return;
        }
        const { description, chapters, posterSize } = prepared;
        sender.send({
          type: 'share.prepared',
          requestId,
          ...(description === undefined ? {} : { description }),
          chapters,
          posterSize,
        });
      });
  }

  async prepare(runId: string, format: RenderFormat): Promise<Prepared> {
    const { platform } = this.deps;
    const p = pathFor(platform);
    const entry = await findReportedRun(this.deps.indexFile, runId);
    if (entry === null) return { ok: false, code: 'not-found' };
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(p.join(entry.runDir, RESULT_FILE), 'utf8'),
      );
    } catch {
      return { ok: false, code: 'not-found' };
    }
    const parsed = RunResultSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'not-found' };
    const render = parsed.data.renders.find((item) => item.format === format);
    if (render === undefined) return { ok: false, code: 'no-render' };

    // The same boundary as the relay: only a file inside the run directory.
    let file: string;
    try {
      const root = await realpath(entry.runDir);
      file = await realpath(p.resolve(entry.runDir, render.file));
      if (!isInside(root, file, platform)) {
        return { ok: false, code: 'no-render' };
      }
    } catch {
      return { ok: false, code: 'no-render' };
    }

    const posterSize = await this.poster({
      render: file,
      poster: posterPath(entry.runDir, format, platform),
      durationMs: render.durationMs,
      platform,
    });
    const description = this.description(entry.root, parsed.data.scenarioId);
    return {
      ok: true,
      ...(description === undefined ? {} : { description }),
      chapters: render.chapters ?? [],
      posterSize,
    };
  }

  private poster(request: PosterRequest): Promise<number> {
    const pending = this.posters.get(request.poster);
    if (pending !== undefined) return pending;
    const making = this.deps.makePoster(request).finally(() => {
      this.posters.delete(request.poster);
    });
    this.posters.set(request.poster, making);
    return making;
  }

  /**
   * The scenario's description, from its file in the project the run was
   * reported from — and only from inside that project.
   */
  private description(
    root: string | undefined,
    scenarioId: string,
  ): string | undefined {
    if (root === undefined) return undefined;
    const p = pathFor(this.deps.platform);
    if (!isInside(root, p.resolve(root, scenarioId), this.deps.platform)) {
      return undefined;
    }
    const description = scenarioDescription(root, scenarioId)?.trim();
    return description === undefined || description === ''
      ? undefined
      : description.slice(0, DESCRIPTION_MAX_LENGTH);
  }
}

/** The daemon's preparer, with the real FFmpeg. */
export function sharePreparer(
  deps: Omit<ShareDeps, 'makePoster'>,
): SharePreparer {
  return new SharePreparer({ ...deps, makePoster: (r) => makePoster(r) });
}
