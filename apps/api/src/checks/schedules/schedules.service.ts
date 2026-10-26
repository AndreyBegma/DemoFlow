import {
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type { CheckSchedule, Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../database/prisma.service';
import {
  RunnerConnections,
  type SchedulesSink,
} from '../../runner/runner-connections.service';
import type {
  SchedulesMessage,
  SyncedSchedule,
} from '../../runner/runner-socket';
import { runError } from '../../videos/runs.service';
import { lastDueSlot, nextDueSlot } from '../slots';
import type { PutScheduleDto } from './schedules.dto';

/** Why a `site` schedule does not run (spec #362). */
export type PausedReason = 'config-schedule' | 'no-machine' | 'cli-too-old';

/** A schedule as the website reads it (spec #362, API). */
export interface ScheduleView {
  source: 'site' | 'config';
  cadence: CheckSchedule['cadence'];
  weekday: string | null;
  at: string;
  timeZone: string;
  exclude: string[];
  pausedReason: string | null;
  /** Computed, never stored; null while paused. */
  nextDueAt: Date | null;
  /** The start of the project's latest reported check run. */
  lastPassAt: Date | null;
}

export interface ScheduleMachine {
  id: string;
  name: string;
  online: boolean;
  /** The zone of the machine's latest `schedules.sync`, for the form's default. */
  zone: string | null;
}

export interface ProjectSchedules {
  site: ScheduleView | null;
  config: ScheduleView | null;
  machine: ScheduleMachine | null;
}

/**
 * A project's check schedules (spec #362, Decision 2): the `site` row the
 * website sets, and the `config` row the daemon reports from the project's
 * config with `schedules.sync`. The API runs only `site` rows
 * (`CheckScheduler`); `config` rows are shown.
 */
@Injectable()
export class SchedulesService implements SchedulesSink, OnModuleInit {
  private readonly logger = new Logger(SchedulesService.name);
  /** The zone of each machine's latest `schedules.sync`. */
  private readonly zones = new Map<string, string>();
  /** One machine's syncs apply in the order they came. */
  private readonly syncs = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setSchedulesSink(this);
  }

  async get(userId: string, projectId: string): Promise<ProjectSchedules> {
    const project = await this.owned(userId, projectId);
    const rows = await this.prisma.checkSchedule.findMany({
      where: { projectId },
    });
    const lastPassAt = await this.lastPassAt(projectId);
    const view = (source: 'site' | 'config') => {
      const row = rows.find((candidate) => candidate.source === source);
      return row ? this.toView(row, lastPassAt) : null;
    };
    const runner = project.runner;
    return {
      site: view('site'),
      config: view('config'),
      machine:
        runner && runner.revokedAt === null
          ? {
              id: runner.id,
              name: runner.name,
              online: this.connections.isOnline(runner.id),
              zone: this.zones.get(runner.id) ?? null,
            }
          : null,
    };
  }

  /**
   * Creates or replaces the `site` row. A new schedule never fires at once:
   * `lastSlotAt` starts at the slot already due.
   */
  async put(
    userId: string,
    projectId: string,
    dto: PutScheduleDto,
  ): Promise<ScheduleView> {
    const project = await this.owned(userId, projectId);
    const config = await this.prisma.checkSchedule.count({
      where: { projectId, source: 'config' },
    });
    if (config > 0) {
      throw runError(HttpStatus.CONFLICT, 'config-schedule');
    }
    if (
      !project.runner ||
      project.runner.revokedAt !== null ||
      project.rootPath === null
    ) {
      throw runError(HttpStatus.CONFLICT, 'no-machine');
    }
    const fields = {
      cadence: dto.cadence,
      weekday: dto.cadence === 'weekly' ? (dto.weekday ?? null) : null,
      at: dto.at,
      timeZone: dto.timeZone,
      exclude: dto.exclude ?? [],
    };
    const data = {
      ...fields,
      pausedReason: null,
      lastSlotAt: lastDueSlot(fields, this.clock.now(), fields.timeZone),
    };
    const row = await this.prisma.checkSchedule.upsert({
      where: { projectId_source: { projectId, source: 'site' } },
      create: { projectId, source: 'site', ...data },
      update: data,
    });
    return this.toView(row, await this.lastPassAt(projectId));
  }

  async remove(userId: string, projectId: string): Promise<void> {
    await this.owned(userId, projectId);
    await this.prisma.checkSchedule.deleteMany({
      where: { projectId, source: 'site' },
    });
  }

  /** `schedules.sync` (spec 361, Decision 6), from `RunnerConnections`. */
  sync(runnerId: string, message: SchedulesMessage): void {
    const previous = this.syncs.get(runnerId) ?? Promise.resolve();
    const next = previous
      .then(() => this.apply(runnerId, message))
      .catch((error: unknown) => {
        this.logger.error(
          `schedules.sync from ${runnerId} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        if (this.syncs.get(runnerId) === next) {
          this.syncs.delete(runnerId);
        }
      });
    this.syncs.set(runnerId, next);
  }

  private async apply(
    runnerId: string,
    message: SchedulesMessage,
  ): Promise<void> {
    this.zones.set(runnerId, message.zone);
    const roots = message.projects.map((project) => project.rootPath);
    // A project the server does not know yet is ignored (Decision 2).
    const projects = await this.prisma.project.findMany({
      where: { runnerId, rootPath: { in: roots } },
      select: { id: true, rootPath: true },
    });
    for (const project of projects) {
      const synced = message.projects.find(
        (candidate) => candidate.rootPath === project.rootPath,
      );
      if (!synced) {
        continue;
      }
      await this.prisma.$transaction((tx) =>
        synced.schedule
          ? this.setConfig(tx, project.id, synced.schedule, message.zone)
          : this.dropConfig(tx, project.id),
      );
    }
  }

  private async setConfig(
    tx: Prisma.TransactionClient,
    projectId: string,
    schedule: SyncedSchedule,
    zone: string,
  ): Promise<void> {
    const data = {
      cadence: schedule.cadence,
      weekday:
        schedule.cadence === 'weekly' ? (schedule.weekday ?? null) : null,
      at: schedule.at,
      timeZone: zone,
      exclude: schedule.exclude ?? [],
    };
    await tx.checkSchedule.upsert({
      where: { projectId_source: { projectId, source: 'config' } },
      create: { projectId, source: 'config', ...data },
      update: data,
    });
    await tx.checkSchedule.updateMany({
      where: { projectId, source: 'site' },
      data: { pausedReason: 'config-schedule' },
    });
  }

  /** The pause lifts without a catch-up: the slots it skipped were the daemon's. */
  private async dropConfig(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<void> {
    const { count } = await tx.checkSchedule.deleteMany({
      where: { projectId, source: 'config' },
    });
    if (count === 0) {
      return;
    }
    const site = await tx.checkSchedule.findUnique({
      where: { projectId_source: { projectId, source: 'site' } },
    });
    if (site?.pausedReason !== 'config-schedule') {
      return;
    }
    await tx.checkSchedule.update({
      where: { id: site.id },
      data: {
        pausedReason: null,
        lastSlotAt: lastDueSlot(site, this.clock.now(), site.timeZone),
      },
    });
  }

  private async owned(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: {
        rootPath: true,
        runner: { select: { id: true, name: true, revokedAt: true } },
      },
    });
    if (!project) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    return project;
  }

  private async lastPassAt(projectId: string): Promise<Date | null> {
    const run = await this.prisma.run.findFirst({
      where: { projectId, kind: 'check' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { startedAt: true },
    });
    return run?.startedAt ?? null;
  }

  private toView(row: CheckSchedule, lastPassAt: Date | null): ScheduleView {
    return {
      source: row.source,
      cadence: row.cadence,
      weekday: row.weekday,
      at: row.at,
      timeZone: row.timeZone,
      exclude: row.exclude,
      pausedReason: row.pausedReason,
      nextDueAt:
        row.pausedReason === null
          ? nextDueSlot(row, this.clock.now(), row.timeZone)
          : null,
      lastPassAt,
    };
  }
}
