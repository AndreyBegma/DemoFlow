import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import {
  type ArtifactsSink,
  RunnerConnections,
} from '../runner/runner-connections.service';
import type {
  ArtifactsErrorCode,
  ArtifactsMessage,
} from '../runner/runner-socket';
import { runError } from './runs.service';

/** No answer this long after `artifacts.delete`: 504 (spec #233, Decision 4). */
export const DELETE_TIMEOUT_MS = 15 * 1000;
/** How often the timeout is checked. */
const SWEEP_INTERVAL_MS = 1000;

/** Runner errors as HTTP (Decision 3). Nothing is recorded for either. */
const RUNNER_ERRORS: Record<
  ArtifactsErrorCode,
  { status: HttpStatus; error: string }
> = {
  'not-found': { status: HttpStatus.NOT_FOUND, error: 'artifacts-missing' },
  io: { status: HttpStatus.BAD_GATEWAY, error: 'runner-error' },
};

type Outcome = { ok: true } | { ok: false; status: HttpStatus; error: string };

interface Pending {
  id: string;
  runnerId: string;
  runId: string;
  /** Clock ms. */
  sentAt: number;
  settle: (outcome: Outcome) => void;
}

/**
 * Deletes a run's directory on the machine that recorded it (spec #233,
 * ADR-0008 §3): asks the Runner over its socket and waits for the answer.
 * The run's metadata stays; only `artifactsDeletedAt` is recorded.
 *
 * Works only on the instance that holds the Runner's socket, like the video
 * relay (spec #191, Decision 10).
 */
@Injectable()
export class ArtifactsService
  implements
    ArtifactsSink,
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy
{
  private readonly logger = new Logger(ArtifactsService.name);
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: RunnerConnections,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setArtifactsSink(this);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Sends `artifacts.delete` and records the deletion once the Runner
   * confirms it. Throws the `{ error }` HTTP answer otherwise.
   */
  async delete(runnerId: string, runId: string): Promise<void> {
    const outcome = await this.ask(runnerId, runId);
    if (!outcome.ok) {
      throw runError(outcome.status, outcome.error);
    }
    // `updateMany`: the run may have gone with its project meanwhile.
    await this.prisma.run.updateMany({
      where: { id: runId, artifactsDeletedAt: null },
      data: { artifactsDeletedAt: this.clock.now() },
    });
  }

  message(runnerId: string, message: ArtifactsMessage): boolean {
    const request = this.pending.get(message.requestId);
    // Only the machine a request was sent to can answer it.
    if (request?.runnerId !== runnerId) {
      return false;
    }
    if (message.type === 'artifacts.deleted') {
      this.finish(request, { ok: true }, 'deleted');
    } else {
      this.finish(
        request,
        { ok: false, ...RUNNER_ERRORS[message.code] },
        message.code,
      );
    }
    return true;
  }

  /** Every request on the machine's socket ends with it (Decision 5). */
  closed(runnerId: string): void {
    for (const request of [...this.pending.values()]) {
      if (request.runnerId === runnerId) {
        this.offline(request);
      }
    }
  }

  /** The timeout, on the injected clock. Runs every `SWEEP_INTERVAL_MS`. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const request of [...this.pending.values()]) {
      if (now - request.sentAt >= DELETE_TIMEOUT_MS) {
        this.finish(
          request,
          {
            ok: false,
            status: HttpStatus.GATEWAY_TIMEOUT,
            error: 'runner-timeout',
          },
          'runner-timeout',
        );
      }
    }
  }

  private ask(runnerId: string, runId: string): Promise<Outcome> {
    return new Promise((settle) => {
      const request: Pending = {
        id: randomUUID(),
        runnerId,
        runId,
        sentAt: this.clock.now().getTime(),
        settle,
      };
      this.pending.set(request.id, request);
      const sent = this.connections.sendTo(runnerId, {
        type: 'artifacts.delete',
        requestId: request.id,
        runId,
      });
      if (!sent) {
        this.offline(request);
      }
    });
  }

  private offline(request: Pending): void {
    this.finish(
      request,
      {
        ok: false,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'runner-offline',
      },
      'runner-offline',
    );
  }

  private finish(request: Pending, outcome: Outcome, label: string): void {
    this.pending.delete(request.id);
    // Decision 9: no email, no path.
    this.logger.log(
      JSON.stringify({
        event: 'artifacts.delete',
        runId: request.runId,
        outcome: label,
        durationMs: this.clock.now().getTime() - request.sentAt,
      }),
    );
    request.settle(outcome);
  }
}
