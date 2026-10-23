import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type RunDetailView,
  toRunDetailView,
} from '../projects/projects.service';
import { RunnerConnections } from '../runner/runner-connections.service';

const RUN_INCLUDE = {
  project: { select: { id: true, name: true } },
  runner: { select: { id: true, name: true, revokedAt: true } },
} satisfies Prisma.RunInclude;

export type OwnedRun = Prisma.RunGetPayload<{ include: typeof RUN_INCLUDE }>;

/** What the run page shows (spec #191, Decision 9). */
export interface RunPage {
  run: RunDetailView;
  project: { id: string; name: string };
  /** Null when the machine was removed: deleted or revoked. */
  machine: { id: string; name: string; online: boolean } | null;
}

/** `{ error }` with a status, the API's error body. */
export function runError(status: HttpStatus, error: string): HttpException {
  return new HttpException({ error }, status);
}

/** One run, only for the account whose project holds it; else 404. */
@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
  ) {}

  async find(userId: string, id: string): Promise<OwnedRun> {
    const run = await this.prisma.run.findFirst({
      where: { id, project: { userId } },
      include: RUN_INCLUDE,
    });
    if (!run) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    return run;
  }

  async page(userId: string, id: string): Promise<RunPage> {
    const run = await this.find(userId, id);
    const machine = liveMachine(run);
    return {
      run: toRunDetailView(run),
      project: run.project,
      machine: machine && {
        id: machine.id,
        name: machine.name,
        online: this.connections.isOnline(machine.id),
      },
    };
  }
}

/** A revoked machine can never serve again: it counts as removed. */
export function liveMachine(run: OwnedRun): OwnedRun['runner'] {
  return run.runner?.revokedAt === null ? run.runner : null;
}
