import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { CheckSchedule } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../database/prisma.service';
import { LaunchesService } from '../../launches/launches.service';
import { RunnerConnections } from '../../runner/runner-connections.service';
import { lastDueSlot } from '../slots';
import type { PausedReason } from './schedules.service';

export const SCHEDULER_INTERVAL_MS = 60 * 1000;

/** Start failures after which the slot is still owed: the pass never began. */
const RETRIABLE = new Set(['runner-busy', 'runner-offline']);

interface Row extends CheckSchedule {
  project: {
    rootPath: string | null;
    runner: { id: string; revokedAt: Date | null } | null;
  };
}

/**
 * Starts a check pass when a `site` schedule is due (spec #362, Decision 4).
 * A missed slot is computed from the clock and `lastSlotAt`, so a machine
 * that was offline, busy or restarting gets one catch-up pass for all of
 * them, and an API restart loses nothing.
 *
 * One API process (deploy/README.md): two would start a pass twice.
 */
@Injectable()
export class CheckScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CheckScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly launches: LaunchesService,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * One pass over the schedules; resolves once every due `check.start` is
   * sent. A tick while one is in flight joins it.
   */
  tick(): Promise<void> {
    this.pass ??= this.run().finally(() => {
      this.pass = undefined;
    });
    return this.pass;
  }

  private async run(): Promise<void> {
    const rows = await this.prisma.checkSchedule.findMany({
      // `config-schedule` lifts only with the `config` row, in `SchedulesService`.
      where: {
        source: 'site',
        OR: [
          { pausedReason: null },
          { pausedReason: { not: 'config-schedule' } },
        ],
      },
      include: {
        project: {
          select: {
            rootPath: true,
            runner: { select: { id: true, revokedAt: true } },
          },
        },
      },
    });
    const now = this.clock.now();
    for (const row of rows) {
      try {
        await this.consider(row, now);
      } catch (error) {
        this.logger.error(
          `Schedule ${row.id} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async consider(row: Row, now: Date): Promise<void> {
    const { runner, rootPath } = row.project;
    if (!runner || runner.revokedAt !== null || rootPath === null) {
      await this.pause(row, 'no-machine');
      return;
    }
    // Null until the machine's `launches.sync`: keep what is known.
    const checks = this.connections.isOnline(runner.id)
      ? this.connections.checks(runner.id)
      : null;
    if (checks === false) {
      await this.pause(row, 'cli-too-old');
      return;
    }
    if (checks === true || row.pausedReason === 'no-machine') {
      await this.pause(row, null);
    }
    if (checks !== true) {
      return;
    }
    const slot = lastDueSlot(row, now, row.timeZone);
    if (
      slot === null ||
      (row.lastSlotAt !== null && slot <= row.lastSlotAt) ||
      this.launches.isBusy(runner.id)
    ) {
      return;
    }
    // Written before the request, so a crash or restart never sends it twice.
    const claimed = await this.prisma.checkSchedule.updateMany({
      where: { id: row.id, lastSlotAt: row.lastSlotAt, pausedReason: null },
      data: { lastSlotAt: slot },
    });
    if (claimed.count !== 1) {
      return;
    }
    // Not awaited: `check.start` is sent now, the answer may take seconds.
    void this.launches
      .startCheckPass(
        { projectId: row.projectId, runnerId: runner.id, rootPath },
        row.exclude,
      )
      .then(async (outcome) => {
        if (outcome.ok) {
          return;
        }
        this.logger.warn(
          `Check pass of project ${row.projectId} not started: ${outcome.error}`,
        );
        if (RETRIABLE.has(outcome.error)) {
          await this.prisma.checkSchedule.updateMany({
            where: { id: row.id, lastSlotAt: slot },
            data: { lastSlotAt: row.lastSlotAt },
          });
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Check pass of project ${row.projectId} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  private async pause(row: Row, reason: PausedReason | null): Promise<void> {
    if (row.pausedReason === reason) {
      return;
    }
    await this.prisma.checkSchedule.updateMany({
      where: { id: row.id, pausedReason: row.pausedReason },
      data: { pausedReason: reason },
    });
    row.pausedReason = reason;
  }
}
