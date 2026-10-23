import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Run, type Runner, type RunStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateProjectDto,
  RunReportDto,
  UpdateProjectDto,
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
}

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string | null;
  /** Null for a project never bound, or whose machine was revoked. */
  runner: { id: string; name: string } | null;
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
  };
}

function toProjectView(project: ProjectWithSummary): ProjectView {
  const [lastRun] = project.runs;
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    runner: project.runner,
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
  constructor(private readonly prisma: PrismaService) {}

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

  /** Deletes the project; its runs cascade. */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.project.deleteMany({
      where: { id, userId },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
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
