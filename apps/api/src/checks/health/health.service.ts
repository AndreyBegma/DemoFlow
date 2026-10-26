import { HttpStatus, Injectable } from '@nestjs/common';
import type { RunStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runError } from '../../videos/runs.service';

/** At most this many in `GET /checks/stale`. */
export const STALE_LIMIT = 50;

export interface HealthView {
  scenarioPath: string;
  scenarioName: string;
  state: RunStatus;
  since: Date;
  lastRunId: string;
}

export interface StaleView {
  projectId: string;
  projectName: string;
  scenarioPath: string;
  scenarioName: string;
  since: Date;
  lastRunId: string;
}

/**
 * Reads the per-scenario state (spec #362, Decision 6). "Stale" is
 * `state = failed`; `recordHealth` writes it with each report.
 */
@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async project(userId: string, projectId: string): Promise<HealthView[]> {
    const count = await this.prisma.project.count({
      where: { id: projectId, userId },
    });
    if (count !== 1) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    const rows = await this.prisma.scenarioHealth.findMany({
      where: { projectId },
      orderBy: { scenarioPath: 'asc' },
    });
    const names = await this.names(rows.map((row) => row.lastRunId));
    return rows.map((row) => ({
      scenarioPath: row.scenarioPath,
      scenarioName: names.get(row.lastRunId) ?? row.scenarioPath,
      state: row.state,
      since: row.since,
      lastRunId: row.lastRunId,
    }));
  }

  /** The caller's stale scenarios across projects, newest `since` first. */
  async stale(userId: string): Promise<StaleView[]> {
    const rows = await this.prisma.scenarioHealth.findMany({
      where: { state: 'failed', project: { userId } },
      orderBy: [{ since: 'desc' }, { scenarioPath: 'asc' }],
      take: STALE_LIMIT,
      include: { project: { select: { name: true } } },
    });
    const names = await this.names(rows.map((row) => row.lastRunId));
    return rows.map((row) => ({
      projectId: row.projectId,
      projectName: row.project.name,
      scenarioPath: row.scenarioPath,
      scenarioName: names.get(row.lastRunId) ?? row.scenarioPath,
      since: row.since,
      lastRunId: row.lastRunId,
    }));
  }

  /**
   * Each run's scenario name. A deleted run leaves the state as it was
   * (Decision 6), so a missing one falls back to the path.
   */
  private async names(runIds: string[]): Promise<Map<string, string>> {
    const runs = await this.prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { id: true, scenarioName: true },
    });
    return new Map(runs.map((run) => [run.id, run.scenarioName]));
  }
}
