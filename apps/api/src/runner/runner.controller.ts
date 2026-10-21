import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import {
  SKIP_ALL_THROTTLERS,
  THROTTLE_DEVICE_POLL,
  THROTTLE_IP,
} from '../auth/auth-throttle';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import {
  type DeviceAuthorization,
  DeviceCodeService,
  type IssuedToken,
  type PendingDevice,
} from './device-code.service';
import {
  DeviceCodeRequestDto,
  DeviceTokenRequestDto,
  RunnerNameDto,
} from './runner.dto';
import type { RunnerContext } from './runner-token';
import { CurrentRunner, RunnerTokenGuard } from './runner-token.guard';
import { RunnersService } from './runners.service';

/**
 * Pairing a machine (spec #135): the public device-code endpoints the CLI
 * calls, the approval a signed-in user gives, and the calls a paired machine
 * makes with its token.
 */
@Controller('runner')
@SkipThrottle(SKIP_ALL_THROTTLERS)
export class RunnerController {
  constructor(
    private readonly devices: DeviceCodeService,
    private readonly runners: RunnersService,
  ) {}

  @Post('device/code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  requestCode(
    @Body() body: DeviceCodeRequestDto,
  ): Promise<DeviceAuthorization> {
    return this.devices.start(body);
  }

  @Post('device/token')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_DEVICE_POLL]: false })
  pollToken(@Body() body: DeviceTokenRequestDto): Promise<IssuedToken> {
    return this.devices.poll(body.deviceCode);
  }

  // Session only: an unverified user still sees the code, and the page says
  // to verify first.
  @Get('device/:userCode')
  @UseGuards(SessionGuard)
  describe(@Param('userCode') userCode: string): Promise<PendingDevice> {
    return this.devices.describe(userCode);
  }

  @Post('device/:userCode/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard, VerifiedGuard)
  approve(
    @Param('userCode') userCode: string,
    @Body() body: RunnerNameDto,
    @CurrentUser() user: User,
  ): Promise<void> {
    return this.devices.approve(userCode, user.id, body.name);
  }

  @Post('device/:userCode/deny')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard, VerifiedGuard)
  deny(@Param('userCode') userCode: string): Promise<void> {
    return this.devices.deny(userCode);
  }

  @Get('self')
  @UseGuards(RunnerTokenGuard)
  self(@CurrentRunner() caller: RunnerContext): {
    runnerId: string;
    name: string;
    email: string;
  } {
    return {
      runnerId: caller.runner.id,
      name: caller.runner.name,
      email: caller.user.email,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RunnerTokenGuard)
  logout(@CurrentRunner() caller: RunnerContext): Promise<void> {
    return this.runners.revoke(caller.user.id, caller.runner.id);
  }
}
