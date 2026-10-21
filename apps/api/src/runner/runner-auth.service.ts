import { Injectable } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { generateToken, hashToken } from '../auth/tokens';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RUNNER_TOKEN_PREFIX, type RunnerContext } from './runner-token';

/** `lastUsedAt` moves at most once a minute, so a call rarely costs a write. */
export const RUNNER_LAST_USED_INTERVAL_MS = 60 * 1000;
/** A token this old is replaced on the next connect (spec #151 Decision 8). */
export const TOKEN_ROTATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A rotation not acknowledged within this is discarded; the old token stays. */
export const PENDING_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The device token's whole life after pairing: the check every runner call
 * and the socket upgrade go through, and the rotation that replaces it.
 *
 * A pending token — sent in `rotate` and not yet acknowledged — authenticates
 * too while it is fresh, and using it completes the rotation. A daemon that
 * saved the new token but lost the socket before its `rotated` arrived would
 * otherwise be locked out (amends spec #151 Decision 8).
 */
@Injectable()
export class RunnerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** The machine and account behind `Bearer dfr_…`, or null. */
  async authenticate(
    authorization: string | undefined,
  ): Promise<RunnerContext | null> {
    const token = BEARER.exec(authorization ?? '')?.[1];
    if (!token?.startsWith(RUNNER_TOKEN_PREFIX)) {
      return null;
    }
    const hash = hashToken(token);
    const now = this.clock.now();

    let runner = await this.prisma.runner.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });
    if (runner && this.isStalePending(runner, now)) {
      await this.prisma.runner.updateMany({
        where: { id: runner.id, pendingTokenHash: runner.pendingTokenHash },
        data: { pendingTokenHash: null, pendingIssuedAt: null },
      });
    }
    if (!runner) {
      const pending = await this.prisma.runner.findUnique({
        where: { pendingTokenHash: hash },
      });
      if (!pending || !(await this.promote(pending, now))) {
        return null;
      }
      runner = await this.prisma.runner.findUnique({
        where: { tokenHash: hash },
        include: { user: true },
      });
    }
    if (!runner || runner.revokedAt) {
      return null;
    }

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
    return { runner: row, user };
  }

  /**
   * A new token for `runner` when its current one is due, stored as pending
   * (replacing any earlier pending one). Null when not due or revoked.
   */
  async startRotation(runner: Runner): Promise<string | null> {
    const now = this.clock.now();
    if (
      now.getTime() - runner.tokenIssuedAt.getTime() <
      TOKEN_ROTATION_AGE_MS
    ) {
      return null;
    }
    const token = `${RUNNER_TOKEN_PREFIX}${generateToken()}`;
    const { count } = await this.prisma.runner.updateMany({
      where: { id: runner.id, revokedAt: null },
      data: { pendingTokenHash: hashToken(token), pendingIssuedAt: now },
    });
    return count === 1 ? token : null;
  }

  /** The daemon's `rotated`: the pending token replaces the current one. */
  async completeRotation(runnerId: string): Promise<boolean> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
    });
    return runner ? this.promote(runner, this.clock.now()) : false;
  }

  /** Compare-and-set, so a concurrent rotation or revoke wins cleanly. */
  private async promote(runner: Runner, now: Date): Promise<boolean> {
    const pendingTokenHash = runner.pendingTokenHash;
    if (
      !pendingTokenHash ||
      runner.revokedAt ||
      this.isStalePending(runner, now)
    ) {
      return false;
    }
    const { count } = await this.prisma.runner.updateMany({
      where: { id: runner.id, pendingTokenHash, revokedAt: null },
      data: {
        tokenHash: pendingTokenHash,
        tokenIssuedAt: now,
        pendingTokenHash: null,
        pendingIssuedAt: null,
      },
    });
    return count === 1;
  }

  private isStalePending(runner: Runner, now: Date): boolean {
    return (
      runner.pendingIssuedAt !== null &&
      now.getTime() - runner.pendingIssuedAt.getTime() >= PENDING_TOKEN_TTL_MS
    );
  }
}
