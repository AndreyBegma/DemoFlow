import { Injectable, NotFoundException } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';

/** A machine as the API returns it: never its token hash. */
export interface RunnerView {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function toRunnerView(runner: Runner): RunnerView {
  return {
    id: runner.id,
    name: runner.name,
    os: runner.os,
    cliVersion: runner.cliVersion,
    createdAt: runner.createdAt,
    lastUsedAt: runner.lastUsedAt,
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
  ) {}

  async list(userId: string): Promise<RunnerView[]> {
    const runners = await this.prisma.runner.findMany({
      where: { userId, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return runners.map(toRunnerView);
  }

  async rename(userId: string, id: string, name: string): Promise<RunnerView> {
    const { count } = await this.prisma.runner.updateMany({
      where: { id, userId, revokedAt: null },
      data: { name },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
    return toRunnerView(
      await this.prisma.runner.findUniqueOrThrow({ where: { id } }),
    );
  }

  async revoke(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.runner.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
  }
}
