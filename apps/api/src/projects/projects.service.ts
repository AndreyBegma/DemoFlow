import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type ProjectSource,
  type Run,
  type Runner,
  type RunStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ShareStorage } from '../shares/share-storage';
import {
  type CreateProjectDto,
  RUN_FORMATS,
  RUN_STAGE_STATUSES,
  RUN_STAGES,
  type RunFormat,
  type RunReportDto,
  type RunStage,
  type RunStageStatus,
  type UpdateProjectDto,
} from './projects.dto';

/** Runs per page of a project's library (spec #178, Decision 5). */
export const RUNS_PAGE_SIZE = 50;

/** A run as the API returns it: metadata only (Decision 1). */
export interface RunView {
  id: string;
  scenarioName: string;
  scenarioPath: string;
  status: 'passed' | 'failed';
  startedAt: Date;
  durationMs: number;
  formats: string[];
  failedStep: number | null;
  cliVersion: string;
  /** When the machine deleted the run's directory (spec #233); null while it is there. */
  artifactsDeletedAt: Date | null;
  /** `check` for a check run (spec 360); null for an ordinary run. */
  kind: 'check' | null;
}

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string | null;
  /** Null for a project never bound, or whose machine was revoked. */
  runner: { id: string; name: string } | null;
  /** `https://github.com/<owner>/<repo>`, display only (ADR-0022 §5). */
  githubUrl: string | null;
  /** `website` when added through the folder dialog (spec #378). */
  source: ProjectSource;
  runCount: number;
  lastRun: RunView | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunsPage {
  runs: RunView[];
  nextCursor: string | null;
}

const NEWEST_FIRST: Prisma.RunOrderByWithRelationInput[] = [
  { startedAt: 'desc' },
  { id: 'desc' },
];

const PROJECT_INCLUDE = {
  runner: { select: { id: true, name: true } },
  runs: { orderBy: NEWEST_FIRST, take: 1 },
  _count: { select: { runs: true } },
} satisfies Prisma.ProjectInclude;

type ProjectWithSummary = Prisma.ProjectGetPayload<{
  include: typeof PROJECT_INCLUDE;
}>;

export function toRunView(run: Run): RunView {
  return {
    id: run.id,
    scenarioName: run.scenarioName,
    scenarioPath: run.scenarioPath,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    formats: run.formats,
    failedStep: run.failedStep,
    cliVersion: run.cliVersion,
    artifactsDeletedAt: run.artifactsDeletedAt,
    kind: run.kind,
  };
}

export type RunStages = Record<RunStage, RunStageStatus>;

export interface RunRender {
  format: RunFormat;
  width: number;
  height: number;
  sizeBytes: number;
  durationMs: number;
}

/** A run as its own page returns it (spec #263, Decision 4). Null: not reported. */
export type RunDetailView = RunView & {
  stages: RunStages | null;
  renders: RunRender[] | null;
  failure: { stage: RunStage; message: string } | null;
};

export function toRunDetailView(run: Run): RunDetailView {
  const failureStage = oneOf(RUN_STAGES, run.failureStage);
  return {
    ...toRunView(run),
    stages: parseStages(run.stages),
    renders: parseRenders(run.renders),
    failure:
      failureStage && run.failureMessage !== null
        ? { stage: failureStage, message: run.failureMessage }
        : null,
  };
}

// The JSON columns are untyped: a value the DTO could not have written reads
// as null rather than reaching the page.

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
}

function parseStages(value: Prisma.JsonValue): RunStages | null {
  if (!isRecord(value) || !hasExactKeys(value, RUN_STAGES)) {
    return null;
  }
  const stages: Partial<RunStages> = {};
  for (const stage of RUN_STAGES) {
    const status = oneOf(RUN_STAGE_STATUSES, value[stage]);
    if (!status) {
      return null;
    }
    stages[stage] = status;
  }
  return stages as RunStages;
}

const RENDER_KEYS = ['format', 'width', 'height', 'sizeBytes', 'durationMs'];

export function parseRenders(value: Prisma.JsonValue): RunRender[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const renders: RunRender[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, RENDER_KEYS)) {
      return null;
    }
    const format = oneOf(RUN_FORMATS, item.format);
    const { width, height, sizeBytes, durationMs } = item;
    if (
      !format ||
      !isInteger(width) ||
      !isInteger(height) ||
      !isInteger(sizeBytes) ||
      !isInteger(durationMs)
    ) {
      return null;
    }
    renders.push({ format, width, height, sizeBytes, durationMs });
  }
  return renders;
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function toProjectView(project: ProjectWithSummary): ProjectView {
  const [lastRun] = project.runs;
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    runner: project.runner,
    githubUrl: project.githubUrl,
    source: project.source,
    runCount: project._count.runs,
    lastRun: lastRun ? toRunView(lastRun) : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function lastActivity(project: ProjectView): number {
  return (project.lastRun?.startedAt ?? project.createdAt).getTime();
}

/**
 * Projects and their runs (spec #178). One project per `(runnerId, rootPath)`.
 * Every session query is scoped by `userId`: another account's project or
 * machine answers 404.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shareStorage: ShareStorage,
  ) {}

  /** Upserts the folder's project and adds the run (Decision 3). */
  async report(
    runner: Runner,
    report: RunReportDto,
  ): Promise<{ projectId: string; runId: string }> {
    return this.prisma.$transaction(async (tx) => {
      // A project that exists keeps its name: it may have been renamed on the site.
      const project = await tx.project.upsert({
        where: {
          runnerId_rootPath: { runnerId: runner.id, rootPath: report.rootPath },
        },
        create: {
          userId: runner.userId,
          runnerId: runner.id,
          rootPath: report.rootPath,
          name: report.projectName,
        },
        update: {},
        select: { id: true },
      });
      const run = await tx.run.create({
        data: {
          projectId: project.id,
          runnerId: runner.id,
          scenarioName: report.scenarioName,
          scenarioPath: report.scenarioPath,
          status: report.status,
          startedAt: new Date(report.startedAt),
          durationMs: report.durationMs,
          formats: report.formats,
          failedStep: report.failedStep ?? null,
          cliVersion: report.cliVersion,
          stages: report.stages ? { ...report.stages } : Prisma.DbNull,
          renders: report.renders
            ? report.renders.map((render) => ({ ...render }))
            : Prisma.DbNull,
          failureStage: report.failure?.stage ?? null,
          failureMessage: report.failure?.message ?? null,
          kind: report.kind ?? null,
        },
        select: { id: true },
      });
      return { projectId: project.id, runId: run.id };
    });
  }

  /** Newest activity first: the last run, else the creation time. */
  async list(userId: string): Promise<ProjectView[]> {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      include: PROJECT_INCLUDE,
    });
    return projects
      .map(toProjectView)
      .sort(
        (a, b) => lastActivity(b) - lastActivity(a) || b.id.localeCompare(a.id),
      );
  }

  /** A project with no folder: it stays empty until one is bound (Decision 4). */
  async create(userId: string, body: CreateProjectDto): Promise<ProjectView> {
    const project = await this.prisma.project.create({
      data: { userId, name: body.name },
      include: PROJECT_INCLUDE,
    });
    return toProjectView(project);
  }

  /**
   * The project of a folder the machine registered (spec #378, Decision 5):
   * `rootPath` is the machine's canonical answer, never the browser's path.
   * A folder another project already holds answers `409 project-exists`
   * with that project's id.
   */
  async createFromFolder(
    userId: string,
    folder: {
      runnerId: string;
      rootPath: string;
      name: string;
      githubUrl: string | null;
    },
  ): Promise<ProjectView> {
    try {
      const project = await this.prisma.project.create({
        data: { userId, ...folder, source: 'website' },
        include: PROJECT_INCLUDE,
      });
      return toProjectView(project);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const holder = await this.prisma.project.findUnique({
          where: {
            runnerId_rootPath: {
              runnerId: folder.runnerId,
              rootPath: folder.rootPath,
            },
          },
          select: { id: true },
        });
        throw new HttpException(
          { error: 'project-exists', projectId: holder?.id ?? null },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Renames and binds. Binding to a folder another project already holds
   * merges it into this one, in one transaction: its runs move here, it is
   * deleted, and this project keeps its name (Decision 4).
   */
  async update(
    userId: string,
    id: string,
    body: UpdateProjectDto,
  ): Promise<ProjectView> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!project) {
          throw new NotFoundException();
        }
        const data: Prisma.ProjectUpdateInput = {};
        if (body.name !== undefined) {
          data.name = body.name;
        }
        if (body.githubUrl !== undefined) {
          data.githubUrl = body.githubUrl;
        }
        if (body.runnerId !== undefined && body.rootPath !== undefined) {
          const runner = await tx.runner.findFirst({
            where: { id: body.runnerId, userId, revokedAt: null },
            select: { id: true },
          });
          if (!runner) {
            throw new NotFoundException();
          }
          const holder = await tx.project.findUnique({
            where: {
              runnerId_rootPath: {
                runnerId: runner.id,
                rootPath: body.rootPath,
              },
            },
            select: { id: true },
          });
          if (holder && holder.id !== id) {
            // Locked first, so a run reported meanwhile waits and then lands
            // on this project instead of being deleted with the holder.
            await tx.$queryRaw`SELECT 1 FROM "Project" WHERE "id" = ${holder.id} FOR UPDATE`;
            await tx.run.updateMany({
              where: { projectId: holder.id },
              data: { projectId: id },
            });
            await tx.project.delete({ where: { id: holder.id } });
          }
          data.runner = { connect: { id: runner.id } };
          data.rootPath = body.rootPath;
        }
        await tx.project.update({ where: { id }, data });
      });
    } catch (error) {
      // Another bind or a first report took the folder in between.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException();
      }
      throw error;
    }
    return this.get(userId, id);
  }

  /**
   * Deletes the project; its runs and their shares cascade, and the shares'
   * directories go once the rows are gone (spec #347, Decision 9).
   */
  async remove(userId: string, id: string): Promise<void> {
    const shares = await this.prisma.share.findMany({
      where: { run: { project: { id, userId } } },
      select: { id: true },
    });
    const { count } = await this.prisma.project.deleteMany({
      where: { id, userId },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
    await this.shareStorage.remove(shares.map((share) => share.id));
  }

  /**
   * Newest first, `RUNS_PAGE_SIZE` per page; `cursor` is the last run seen,
   * and must have the same `status` when one is given.
   */
  async runs(
    userId: string,
    id: string,
    cursor?: string,
    status?: RunStatus,
  ): Promise<RunsPage> {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException();
    }
    if (cursor !== undefined) {
      const seen = await this.prisma.run.count({
        where: { id: cursor, projectId: id, ...(status && { status }) },
      });
      if (seen !== 1) {
        throw new BadRequestException('Unknown cursor');
      }
    }
    const runs = await this.prisma.run.findMany({
      where: { projectId: id, ...(status && { status }) },
      orderBy: NEWEST_FIRST,
      take: RUNS_PAGE_SIZE + 1,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    const page = runs.slice(0, RUNS_PAGE_SIZE);
    return {
      runs: page.map(toRunView),
      nextCursor:
        runs.length > RUNS_PAGE_SIZE
          ? (page[page.length - 1]?.id ?? null)
          : null,
    };
  }

  /**
   * Deletes the project's runs among `runIds` in one statement (spec #286).
   * Ids that are not runs of this project are skipped; only the rows go, the
   * video files on the machine stay. Shares of those runs go with them.
   */
  async removeRuns(
    userId: string,
    id: string,
    runIds: string[],
  ): Promise<{ deleted: number }> {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException();
    }
    const shares = await this.prisma.share.findMany({
      where: { run: { projectId: id, id: { in: runIds } } },
      select: { id: true },
    });
    const { count } = await this.prisma.run.deleteMany({
      where: { projectId: id, id: { in: runIds } },
    });
    this.logger.log(
      `runs.delete project=${id} asked=${runIds.length} deleted=${count}`,
    );
    await this.shareStorage.remove(shares.map((share) => share.id));
    return { deleted: count };
  }

  private async get(userId: string, id: string): Promise<ProjectView> {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      include: PROJECT_INCLUDE,
    });
    if (!project) {
      throw new NotFoundException();
    }
    return toProjectView(project);
  }
}
