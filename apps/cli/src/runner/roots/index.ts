import {
  type InitTemplateResult,
  writeInitTemplate,
} from '../../commands/init.ts';
import { PROJECT_CONFIG_FILE } from '../../config/index.ts';
import { type HostEnvironment, pathFor } from '../../config/platform.ts';
import type { Clock } from '../connection.ts';
import type { LaunchFs, ProjectLoad } from '../launch/checks.ts';
import type { Logger } from '../log.ts';
import { readAllowedRoots } from './allowed.ts';
import { fitted, type Inspection, inspectFolder } from './inspect.ts';
import { isAllowedPath } from './path-rule.ts';
import { registerWebsiteProject, websiteRoots } from './registry.ts';

/** Decision 10: a request not answered by then is answered `internal`. */
export const PROJECT_REQUEST_MAX_MS = 5_000;

export const PROJECT_REQUESTS = [
  'project.inspect',
  'project.init',
  'project.register',
] as const;
type ProjectRequest = (typeof PROJECT_REQUESTS)[number];

/** Decision 4: the codes of `project.error`. */
export type ProjectErrorCode =
  | 'path-not-allowed'
  | 'config-missing'
  | 'config-invalid'
  | 'busy'
  | 'internal';

/** The socket, as the project requests see it: JSON text frames only. */
export interface ProjectsSender {
  send(message: Record<string, unknown>): void;
}

/** What the connection needs from the project requests. */
export interface ProjectsPort {
  handle(message: Record<string, unknown>, sender: ProjectsSender): void;
}

export interface ProjectsDeps {
  /** `allowed-roots.json`, read on every request. */
  allowedRootsFile: string;
  /** `website-projects.jsonl`. */
  websiteProjectsFile: string;
  host: HostEnvironment;
  fs: LaunchFs;
  logger: Logger;
  clock: Clock;
  loadProject(root: string): ProjectLoad;
  /** The `demoflow init` template, never through a link (Decision 7). */
  writeTemplate(root: string): Promise<InitTemplateResult>;
}

export const defaultWriteTemplate = (root: string) =>
  writeInitTemplate(root, { noLinks: true });

/** A refusal that becomes `project.error` with its code. */
class Refused extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode) {
    super(code);
    this.code = code;
  }
}

/** A request id as `runner.log` shows it: one short line, whatever was sent. */
function shown(requestId: string): string {
  return requestId.slice(0, 64).replace(/[^A-Za-z0-9-]/g, '?');
}

/**
 * Decision 8: a root the website registered counts for `checkProject` only
 * while it is still in the file and still passes the path rule, as itself.
 */
export async function isWebsiteRegistered(
  rootPath: string,
  deps: Pick<
    ProjectsDeps,
    'allowedRootsFile' | 'websiteProjectsFile' | 'host'
  > & {
    fs: Pick<LaunchFs, 'realpath' | 'lstat'>;
  },
): Promise<boolean> {
  if (!(await websiteRoots(deps.websiteProjectsFile)).has(rootPath)) {
    return false;
  }
  const { roots } = readAllowedRoots(deps.allowedRootsFile, deps.host);
  const check = await isAllowedPath(
    rootPath,
    roots,
    deps.host.platform,
    deps.fs,
  );
  return check.ok && check.root === rootPath;
}

/**
 * Spec 377: the daemon's side of `project.inspect`, `project.init` and
 * `project.register` (ADR-0022 §3). One at a time; each is answered within
 * 5 s. `runner.log` gets request ids, outcomes and codes, never a path.
 */
export class ProjectRequests implements ProjectsPort {
  private readonly deps: ProjectsDeps;
  private inFlight = false;

  constructor(deps: ProjectsDeps) {
    this.deps = deps;
  }

  handle(message: Record<string, unknown>, sender: ProjectsSender): void {
    const { type, requestId, path } = message;
    const { logger } = this.deps;
    if (!PROJECT_REQUESTS.includes(type as ProjectRequest)) return;
    if (typeof requestId !== 'string') {
      logger.log('warn', `ignored a malformed ${type as string}`);
      return;
    }
    const request = type as ProjectRequest;
    const label = `${request} ${shown(requestId)}`;
    const refuse = (code: ProjectErrorCode) => {
      logger.log('info', `${label}: refused ${code}`);
      sender.send({ type: 'project.error', requestId, code });
    };
    if (this.inFlight) {
      refuse('busy');
      return;
    }
    this.inFlight = true;
    let answered = false;
    const answer = (send: () => void) => {
      if (answered) return;
      answered = true;
      cancelTimer();
      send();
    };
    const cancelTimer = this.deps.clock.after(PROJECT_REQUEST_MAX_MS, () => {
      answer(() => refuse('internal'));
    });
    void this.run(request, path)
      .then(
        (reply) =>
          answer(() => {
            logger.log('info', `${label}: answered`);
            sender.send({ ...reply, requestId });
          }),
        (error: unknown) =>
          answer(() =>
            refuse(error instanceof Refused ? error.code : 'internal'),
          ),
      )
      .finally(() => {
        // Busy until the work itself is over, even after a timeout.
        this.inFlight = false;
      });
  }

  private async run(
    request: ProjectRequest,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const { roots } = readAllowedRoots(
      this.deps.allowedRootsFile,
      this.deps.host,
    );
    const check = await isAllowedPath(
      raw,
      roots,
      this.deps.host.platform,
      this.deps.fs,
    );
    if (!check.ok) throw new Refused('path-not-allowed');
    const root = check.root;
    switch (request) {
      case 'project.inspect':
        return fitted(
          (inspection) => ({ type: 'project.inspected', inspection }),
          await this.inspect(root, roots),
        );
      case 'project.init': {
        const { created, kept } = await this.deps.writeTemplate(root);
        return fitted(
          (inspection) => ({
            type: 'project.initialised',
            created,
            kept,
            inspection,
          }),
          await this.inspect(root, roots),
        );
      }
      case 'project.register':
        await this.register(root);
        return { type: 'project.registered', rootPath: root };
    }
  }

  private inspect(root: string, roots: readonly string[]): Promise<Inspection> {
    return inspectFolder(root, roots, {
      fs: this.deps.fs,
      platform: this.deps.host.platform,
      loadProject: this.deps.loadProject,
    });
  }

  /** Decision 8: a config that exists and loads, then one line in the registry. */
  private async register(root: string): Promise<void> {
    const p = pathFor(this.deps.host.platform);
    try {
      const config = await this.deps.fs.lstat(
        p.join(root, PROJECT_CONFIG_FILE),
      );
      if (!config.isFile()) throw new Refused('config-missing');
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused('config-missing');
    }
    if (!this.deps.loadProject(root).ok) throw new Refused('config-invalid');
    registerWebsiteProject(
      this.deps.websiteProjectsFile,
      root,
      new Date(this.deps.clock.now()).toISOString(),
    );
  }
}
