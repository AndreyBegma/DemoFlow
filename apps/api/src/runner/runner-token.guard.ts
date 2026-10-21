import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { hashToken } from '../auth/tokens';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import {
  RUNNER_TOKEN_PREFIX,
  type RunnerContext,
  type RunnerRequest,
} from './runner-token';

/** `lastUsedAt` moves at most once a minute, so a call rarely costs a write. */
export const RUNNER_LAST_USED_INTERVAL_MS = 60 * 1000;
const BEARER = /^Bearer\s+(\S+)$/i;

/** Requires `Authorization: Bearer dfr_…` of an unrevoked machine. */
@Injectable()
export class RunnerTokenGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RunnerRequest>();
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (!token?.startsWith(RUNNER_TOKEN_PREFIX)) {
      throw new UnauthorizedException();
    }

    const runner = await this.prisma.runner.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!runner || runner.revokedAt) {
      throw new UnauthorizedException();
    }

    const now = this.clock.now();
    if (
      !runner.lastUsedAt ||
      now.getTime() - runner.lastUsedAt.getTime() >=
        RUNNER_LAST_USED_INTERVAL_MS
    ) {
      await this.prisma.runner.updateMany({
        where: { id: runner.id },
        data: { lastUsedAt: now },
      });
    }

    const { user, ...row } = runner;
    req.runnerAuth = { runner: row, user };
    return true;
  }
}

/** The calling machine and its account. Only behind `RunnerTokenGuard`. */
export const CurrentRunner = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RunnerContext => {
    const { runnerAuth } = context.switchToHttp().getRequest<RunnerRequest>();
    if (!runnerAuth) {
      throw new InternalServerErrorException('Used without RunnerTokenGuard');
    }
    return runnerAuth;
  },
);
