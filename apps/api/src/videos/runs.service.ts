import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type RunDetailView,
  toRunDetailView,
} from '../projects/projects.service';
import { RunnerConnections } from '../runner/runner-connections.service';
import type { Feature, RunOption } from '../runner/runner-socket';
import { ShareStorage } from '../shares/share-storage';

const RUN_INCLUDE = {
  project: { select: { id: true, name: true } },
  runner: { select: { id: true, name: true, revokedAt: true } },
} satisfies Prisma.RunInclude;

export type OwnedRun = Prisma.RunGetPayload<{ include: typeof RUN_INCLUDE }>;

/** What the run page shows (spec #191, Decision 9). */
export interface RunPage {
  run: RunDetailView;
  project: { id: string; name: string };
  /**
   * Null when the machine was removed: deleted or revoked. `runOptions` is
   * what it accepts on a start, none while offline (spec #325, Decision 7);
   * `features` what its daemon announced, as `share` (spec #347, Decision 6).
   */
  machine: {
    id: string;
    name: string;
    online: boolean;
    runOptions: RunOption[];
    features: Feature[];
  } | null;
}

/** `{ error }` with a status, the API's error body. */
export function runError(status: HttpStatus, error: string): HttpException {
  return new HttpException({ error }, status);
}

/** One run, only for the account whose project holds it; else 404. */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly shareStorage: ShareStorage,
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
        runOptions: [...this.connections.runOptions(machine.id)],
        features: [...this.connections.features(machine.id)],
      },
    };
  }

  /**
   * Deletes the run's row, never its files (spec #280, Decisions 2–4). One
   * statement: ownership and delete cannot race. Already gone is 404 too.
   * Its shares cascade; their directories go once the row is gone (spec
   * #347, Decision 9).
   */
  async remove(userId: string, id: string): Promise<void> {
    const shares = await this.prisma.share.findMany({
      where: { runId: id, run: { project: { userId } } },
      select: { id: true },
    });
    const { count } = await this.prisma.run.deleteMany({
      where: { id, project: { userId } },
    });
    const outcome = count === 1 ? 'deleted' : 'not-found';
    // Decision 7: no email, no path, no scenario name.
    this.logger.log(
      JSON.stringify({ event: 'run.delete', runId: id, outcome }),
    );
    if (count !== 1) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    await this.shareStorage.remove(shares.map((share) => share.id));
  }
}

/** A revoked machine can never serve again: it counts as removed. */
export function liveMachine(run: OwnedRun): OwnedRun['runner'] {
  return run.runner?.revokedAt === null ? run.runner : null;
}
