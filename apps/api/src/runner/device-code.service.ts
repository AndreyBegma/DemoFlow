import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { generateToken, hashToken } from '../auth/tokens';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { RUNNER_TOKEN_PREFIX } from './runner-token';
import {
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
} from './user-code';

/** RFC 8628 §3.2, as spec #135 Decision 2 sets them. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_S = 5;
/** Active (unrevoked) machines per account (spec #135, Decision 5). */
export const RUNNER_LIMIT = 20;

/** The four RFC 8628 §3.5 answers the token endpoint gives before a token. */
export type DevicePollError =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token';

export interface MachineInfo {
  hostname: string;
  os: string;
  cliVersion: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface PendingDevice {
  userCode: string;
  hostname: string;
  os: string;
  cliVersion: string;
  createdAt: Date;
}

export interface IssuedToken {
  token: string;
  runnerId: string;
  name: string;
  email: string;
}

const USER_CODE_ATTEMPTS = 5;

function pollError(error: DevicePollError): BadRequestException {
  // The object is the whole body: `{ error }`, as RFC 8628 shapes it.
  return new BadRequestException({ error });
}

/** The device-code flow of `demoflow login` (spec #135, ADR-0007 Decision 1). */
@Injectable()
export class DeviceCodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async start(machine: MachineInfo): Promise<DeviceAuthorization> {
    const now = this.clock.now();
    // Expired rows nobody polls again would otherwise stay forever.
    await this.prisma.deviceCode.deleteMany({
      where: { expiresAt: { lte: now } },
    });

    const deviceCode = generateToken();
    const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
    const userCode = await this.insertWithFreshUserCode({
      deviceCodeHash: hashToken(deviceCode),
      hostname: machine.hostname,
      os: machine.os,
      cliVersion: machine.cliVersion,
      expiresAt,
    });

    const verificationUri = `${this.webUrl()}/app/device`;
    const shown = formatUserCode(userCode);
    return {
      deviceCode,
      userCode: shown,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${shown}`,
      expiresIn: DEVICE_CODE_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
    };
  }

  /** The CLI's poll. Throws the RFC 8628 error until the token is issued. */
  async poll(deviceCode: string): Promise<IssuedToken> {
    const row = await this.prisma.deviceCode.findUnique({
      where: { deviceCodeHash: hashToken(deviceCode) },
    });
    // An issued code is deleted, so a second poll lands here too.
    if (!row) {
      throw pollError('expired_token');
    }

    const now = this.clock.now();
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.deviceCode.deleteMany({ where: { id: row.id } });
      throw pollError('expired_token');
    }
    if (row.deniedAt) {
      await this.prisma.deviceCode.deleteMany({ where: { id: row.id } });
      throw pollError('access_denied');
    }

    // `updateMany`: a concurrent poll may have redeemed and deleted the row.
    await this.prisma.deviceCode.updateMany({
      where: { id: row.id },
      data: { lastPolledAt: now },
    });
    if (
      row.lastPolledAt &&
      now.getTime() - row.lastPolledAt.getTime() < POLL_INTERVAL_S * 1000
    ) {
      throw pollError('slow_down');
    }
    if (!row.approvedAt || !row.approvedById || row.runnerName === null) {
      throw pollError('authorization_pending');
    }

    return this.issue(row.id, row.approvedById, row.runnerName, row, now);
  }

  /** What the approval page shows. 404 for an unknown, expired or used code. */
  async describe(input: string): Promise<PendingDevice> {
    const row = await this.findOpen(input);
    return {
      userCode: formatUserCode(row.userCode),
      hostname: row.hostname,
      os: row.os,
      cliVersion: row.cliVersion,
      createdAt: row.createdAt,
    };
  }

  /** Binds the code to `userId` — always the session user, never the body. */
  async approve(input: string, userId: string, name: string): Promise<void> {
    const userCode = this.parse(input);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      // Serializes approvals per account, so two at 19 cannot both pass.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const [active, awaiting] = await Promise.all([
        tx.runner.count({ where: { userId, revokedAt: null } }),
        // Approved but not yet redeemed: each becomes a machine on the next poll.
        tx.deviceCode.count({
          where: {
            approvedById: userId,
            consumedAt: null,
            expiresAt: { gt: now },
          },
        }),
      ]);
      if (active + awaiting >= RUNNER_LIMIT) {
        throw new ConflictException({
          statusCode: 409,
          error: 'runner_limit',
          message: `An account can pair at most ${RUNNER_LIMIT} machines. Revoke one first.`,
        });
      }

      const { count } = await tx.deviceCode.updateMany({
        where: { userCode, ...this.openWhere(now) },
        data: { approvedAt: now, approvedById: userId, runnerName: name },
      });
      if (count !== 1) {
        throw new NotFoundException();
      }
    });
  }

  async deny(input: string): Promise<void> {
    const userCode = this.parse(input);
    const now = this.clock.now();
    const { count } = await this.prisma.deviceCode.updateMany({
      where: { userCode, ...this.openWhere(now) },
      data: { deniedAt: now },
    });
    if (count !== 1) {
      throw new NotFoundException();
    }
  }

  private async issue(
    codeId: string,
    userId: string,
    name: string,
    machine: MachineInfo,
    now: Date,
  ): Promise<IssuedToken> {
    const token = `${RUNNER_TOKEN_PREFIX}${generateToken()}`;
    return this.prisma.$transaction(async (tx) => {
      // The claim: of two concurrent polls, only one sees count 1.
      const { count } = await tx.deviceCode.updateMany({
        where: { id: codeId, consumedAt: null },
        data: { consumedAt: now },
      });
      if (count !== 1) {
        throw pollError('expired_token');
      }
      const runner = await tx.runner.create({
        data: {
          userId,
          name,
          os: machine.os,
          cliVersion: machine.cliVersion,
          tokenHash: hashToken(token),
          // On the clock rotation is measured with (spec #151).
          tokenIssuedAt: now,
        },
        include: { user: true },
      });
      await tx.deviceCode.delete({ where: { id: codeId } });
      return {
        token,
        runnerId: runner.id,
        name: runner.name,
        email: runner.user.email,
      };
    });
  }

  private async findOpen(input: string) {
    const userCode = this.parse(input);
    const row = await this.prisma.deviceCode.findFirst({
      where: { userCode, ...this.openWhere(this.clock.now()) },
    });
    if (!row) {
      throw new NotFoundException();
    }
    return row;
  }

  /** A code nobody has acted on yet, and that has not expired. */
  private openWhere(now: Date): Prisma.DeviceCodeWhereInput {
    return {
      expiresAt: { gt: now },
      approvedAt: null,
      deniedAt: null,
      consumedAt: null,
    };
  }

  private parse(input: string): string {
    const userCode = normalizeUserCode(input);
    if (!userCode) {
      throw new NotFoundException();
    }
    return userCode;
  }

  private async insertWithFreshUserCode(
    data: Omit<Prisma.DeviceCodeCreateInput, 'userCode'>,
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const userCode = generateUserCode();
      try {
        await this.prisma.deviceCode.create({ data: { ...data, userCode } });
        return userCode;
      } catch (error) {
        const collided =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!collided || attempt >= USER_CODE_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private webUrl(): string {
    return (
      this.config.get<string>('WEB_URL') ?? 'http://localhost:3670'
    ).replace(/\/+$/, '');
  }
}
