import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../database/prisma.service';
import {
  type ProjectSink,
  RunnerConnections,
} from '../../runner/runner-connections.service';
import type {
  FolderInspection,
  ProjectMessage,
} from '../../runner/runner-socket';
import { runError } from '../../videos/runs.service';
import { GITHUB_URL_PATTERN, PROJECT_NAME_MAX } from '../projects.dto';
import { ProjectsService, type ProjectView } from '../projects.service';
import type { RegisterFolderDto } from './folders.dto';

/** No answer this long after a `project.*` request: 504 (spec #378, Decision 4). */
export const FOLDER_TIMEOUT_MS = 10 * 1000;
/** How often the timeout is checked. */
const SWEEP_INTERVAL_MS = 1000;

/** What the browser gets of a Runner's inspection (spec #377, Decision 5). */
export interface InspectionView {
  rootPath: string;
  name: string;
  hasConfig: boolean;
  configValid: boolean;
  scenarios: { id: string; name: string }[];
  githubUrl: string | null;
}

export interface InitView {
  created: string[];
  kept: string[];
  inspection: InspectionView;
}

type FolderRequest = 'project.inspect' | 'project.init' | 'project.register';

/** The reply each request waits for, besides `project.error`. */
const REPLIES = {
  'project.inspect': 'project.inspected',
  'project.init': 'project.initialised',
  'project.register': 'project.registered',
} as const satisfies Record<FolderRequest, ProjectMessage['type']>;

type Reply<R extends FolderRequest> = Extract<
  ProjectMessage,
  { type: (typeof REPLIES)[R] }
>;

interface Failure {
  status: HttpStatus;
  error: string;
}

type Outcome = { ok: true; reply: ProjectMessage } | ({ ok: false } & Failure);

/** `project.error` codes as HTTP (Decision 4); anything else is `runner-error`. */
const RUNNER_ERRORS: Record<string, Failure> = {
  'path-not-allowed': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'path-not-allowed',
  },
  'config-missing': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'config-missing',
  },
  'config-invalid': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'config-invalid',
  },
  busy: { status: HttpStatus.CONFLICT, error: 'runner-busy' },
};
const RUNNER_ERROR: Failure = {
  status: HttpStatus.BAD_GATEWAY,
  error: 'runner-error',
};
const OFFLINE: Failure = {
  status: HttpStatus.CONFLICT,
  error: 'runner-offline',
};
const TIMEOUT: Failure = {
  status: HttpStatus.GATEWAY_TIMEOUT,
  error: 'runner-timeout',
};

function runnerFailure(code: string): Failure {
  return Object.hasOwn(RUNNER_ERRORS, code)
    ? RUNNER_ERRORS[code]
    : RUNNER_ERROR;
}

interface Pending {
  id: string;
  runnerId: string;
  type: FolderRequest;
  /** Clock ms. */
  sentAt: number;
  settle: (outcome: Outcome) => void;
}

/**
 * Adds a project from a folder on one of the user's machines (spec #378,
 * ADR-0022): relays `project.inspect`, `project.init` and `project.register`
 * to the machine and answers what it said. Only `register` stores anything,
 * and only the path the machine answered.
 *
 * Works only on the instance that holds the Runner's socket, like the
 * scenario list (spec #247).
 */
@Injectable()
export class FoldersService
  implements ProjectSink, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FoldersService.name);
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: RunnerConnections,
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setProjectSink(this);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async inspect(
    userId: string,
    runnerId: string,
    path: string,
  ): Promise<InspectionView> {
    await this.target(userId, runnerId);
    const reply = await this.ask(runnerId, 'project.inspect', path);
    return toInspectionView(reply.inspection);
  }

  async init(
    userId: string,
    runnerId: string,
    path: string,
  ): Promise<InitView> {
    await this.target(userId, runnerId);
    const reply = await this.ask(runnerId, 'project.init', path);
    return {
      created: [...reply.created],
      kept: [...reply.kept],
      inspection: toInspectionView(reply.inspection),
    };
  }

  /**
   * Decision 5: the project row holds the canonical `rootPath` of
   * `project.registered`. Without a `githubUrl` in the body, the folder is
   * inspected first for its default.
   */
  async register(
    userId: string,
    body: RegisterFolderDto,
  ): Promise<ProjectView> {
    const { runnerId, path } = body;
    await this.target(userId, runnerId);
    let githubUrl = body.githubUrl;
    if (githubUrl === undefined) {
      const inspected = await this.ask(runnerId, 'project.inspect', path);
      githubUrl = toInspectionView(inspected.inspection).githubUrl;
    }
    const { rootPath } = await this.ask(runnerId, 'project.register', path);
    return this.projects.createFromFolder(userId, {
      runnerId,
      rootPath,
      name: body.name ?? folderName(rootPath),
      githubUrl,
    });
  }

  message(runnerId: string, message: ProjectMessage): boolean {
    const request = this.pending.get(message.requestId);
    // Only the machine a request was sent to can answer it, and only in kind.
    if (
      request?.runnerId !== runnerId ||
      (message.type !== 'project.error' &&
        message.type !== REPLIES[request.type])
    ) {
      return false;
    }
    if (message.type === 'project.error') {
      this.end(
        request,
        { ok: false, ...runnerFailure(message.code) },
        message.code,
      );
    } else {
      this.end(request, { ok: true, reply: message }, 'answered');
    }
    return true;
  }

  /** Every request on the machine's socket ends with it. */
  closed(runnerId: string): void {
    for (const request of [...this.pending.values()]) {
      if (request.runnerId === runnerId) {
        this.end(request, { ok: false, ...OFFLINE }, OFFLINE.error);
      }
    }
  }

  /** The timeout, on the injected clock. Runs every `SWEEP_INTERVAL_MS`. */
  tick(): void {
    const now = this.now();
    for (const request of [...this.pending.values()]) {
      if (now - request.sentAt >= FOLDER_TIMEOUT_MS) {
        this.end(request, { ok: false, ...TIMEOUT }, TIMEOUT.error);
      }
    }
  }

  /**
   * Decisions 2 and 3, in order, before anything is sent: the user's own
   * machine (another account's answers as an unknown one), online, and new
   * enough to answer `project.*`.
   */
  private async target(userId: string, runnerId: string): Promise<void> {
    const count = await this.prisma.runner.count({
      where: { id: runnerId, userId, revokedAt: null },
    });
    if (count !== 1) {
      throw runError(HttpStatus.NOT_FOUND, 'runner-not-found');
    }
    if (!this.connections.isOnline(runnerId)) {
      throw runError(OFFLINE.status, OFFLINE.error);
    }
    if (!this.connections.features(runnerId).includes('projects')) {
      throw runError(HttpStatus.CONFLICT, 'runner-outdated');
    }
  }

  private async ask<R extends FolderRequest>(
    runnerId: string,
    type: R,
    path: string,
  ): Promise<Reply<R>> {
    const outcome = await new Promise<Outcome>((settle) => {
      const request: Pending = {
        id: randomUUID(),
        runnerId,
        type,
        sentAt: this.now(),
        settle,
      };
      this.pending.set(request.id, request);
      const sent = this.connections.sendTo(runnerId, {
        type,
        requestId: request.id,
        path,
      });
      if (!sent) {
        this.end(request, { ok: false, ...OFFLINE }, OFFLINE.error);
      }
    });
    if (!outcome.ok) {
      throw runError(outcome.status, outcome.error);
    }
    // `message` settles a request only with its own reply type.
    return outcome.reply as Reply<R>;
  }

  private end(request: Pending, outcome: Outcome, label: string): void {
    this.pending.delete(request.id);
    // No path, no folder name: the machine's layout stays off the logs.
    this.logger.log(
      JSON.stringify({
        event: request.type,
        runnerId: request.runnerId,
        outcome: label,
        durationMs: this.now() - request.sentAt,
      }),
    );
    request.settle(outcome);
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}

/** A URL the API would not accept from the browser is dropped, not passed on. */
function toInspectionView(inspection: FolderInspection): InspectionView {
  const { githubUrl } = inspection;
  return {
    rootPath: inspection.rootPath,
    name: inspection.name,
    hasConfig: inspection.hasConfig,
    configValid: inspection.configValid,
    scenarios: inspection.scenarios.map(({ id, name }) => ({ id, name })),
    githubUrl:
      githubUrl !== undefined && GITHUB_URL_PATTERN.test(githubUrl)
        ? githubUrl
        : null,
  };
}

/** The canonical root's base name, as the inspection names it; Windows paths too. */
export function folderName(rootPath: string): string {
  const name = /^[A-Za-z]:[\\/]|^\\\\/.test(rootPath)
    ? win32.basename(rootPath)
    : posix.basename(rootPath);
  return (name || rootPath).slice(0, PROJECT_NAME_MAX);
}
