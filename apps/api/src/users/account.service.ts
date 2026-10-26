import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { normalizeEmail } from '../auth/email';
import { PrismaService } from '../database/prisma.service';
import { RunnerConnections } from '../runner/runner-connections.service';
import { ShareStorage } from '../shares/share-storage';

export const CONFIRMATION_MISMATCH = 'confirmation-mismatch';

/**
 * Deleting an account (spec #177): immediate, no grace period. Everything
 * hanging off `User` goes through its `onDelete: Cascade`.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly shareStorage: ShareStorage,
  ) {}

  /** `typedEmail` must be the account's email, trimmed, in any case. */
  async delete(user: User, typedEmail: string): Promise<void> {
    // Stored emails are normalized already.
    if (normalizeEmail(typedEmail) !== user.email) {
      throw new BadRequestException({ error: CONFIRMATION_MISMATCH });
    }

    const { runnerIds, shareIds } = await this.prisma.$transaction(
      async (tx) => {
        const runners = await tx.runner.findMany({
          where: { userId: user.id },
          select: { id: true },
        });
        const shares = await tx.share.findMany({
          where: { userId: user.id },
          select: { id: true },
        });
        // A plain column, no cascade: the codes this user approved.
        await tx.deviceCode.deleteMany({ where: { approvedById: user.id } });
        await tx.user.delete({ where: { id: user.id } });
        return {
          runnerIds: runners.map(({ id }) => id),
          shareIds: shares.map(({ id }) => id),
        };
      },
    );

    // After the commit: a socket accepted meanwhile finds no row and closes.
    for (const runnerId of runnerIds) {
      this.connections.revoke(runnerId);
    }
    // The shares cascaded with the user; their files go now (spec #347, Decision 9).
    await this.shareStorage.remove(shareIds);
    this.logger.log(
      JSON.stringify({ event: 'account.deleted', userId: user.id }),
    );
  }
}
