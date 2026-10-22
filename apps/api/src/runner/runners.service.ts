import { Injectable, NotFoundException } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RunnerConnections } from './runner-connections.service';
import { CLOSE_REVOKED } from './runner-socket';

/** A machine as the API returns it: never its token hash. */
export interface RunnerView {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Has an open socket on this API right now (spec #151). */
  online: boolean;
  lastSeenAt: Date | null;
  lastSeenIp: string | null;
}

export function toRunnerView(runner: Runner, online: boolean): RunnerView {
  return {
    id: runner.id,
    name: runner.name,
    os: runner.os,
    cliVersion: runner.cliVersion,
    createdAt: runner.createdAt,
    lastUsedAt: runner.lastUsedAt,
    online,
    lastSeenAt: runner.lastSeenAt,
    lastSeenIp: runner.lastSeenIp,
  };
}

/**
 * An account's machines. Every query is scoped by `userId`: another account's
 * id, an unknown one and a revoked one all answer 404 (spec #135).
 */
@Injectable()
export class RunnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly connections: RunnerConnections,
  ) {}

  async list(userId: string): Promise<RunnerView[]> {
    const runners = await this.prisma.runner.findMany({
      where: { userId, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return runners.map((runner) => this.view(runner));
  }

  async rename(userId: string, id: string, name: string): Promise<RunnerView> {
    const { count } = await this.prisma.runner.updateMany({
      where: { id, userId, revokedAt: null },
      data: { name },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
    return this.view(
      await this.prisma.runner.findUniqueOrThrow({ where: { id } }),
    );
  }

  /**
   * Revokes the token, drops a rotation in flight and the last-seen address
   * (spec #151 Decision 10), unbinds its projects, which stay (spec #178
   * Decision 7), and closes a live socket with `4401`.
   */
  async revoke(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.runner.updateMany({
        where: { id, userId, revokedAt: null },
        data: {
          revokedAt: this.clock.now(),
          pendingTokenHash: null,
          pendingIssuedAt: null,
          lastSeenAt: null,
          lastSeenIp: null,
        },
      });
      if (count !== 1) {
        throw new NotFoundException();
      }
      await tx.project.updateMany({
        where: { runnerId: id },
        data: { runnerId: null },
      });
    });
    this.connections.disconnect(id, CLOSE_REVOKED, 'revoked');
  }

  private view(runner: Runner): RunnerView {
    return toRunnerView(runner, this.connections.isOnline(runner.id));
  }
}
