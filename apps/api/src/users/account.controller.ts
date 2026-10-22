import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { SKIP_ALL_THROTTLERS, THROTTLE_IP } from '../auth/auth-throttle';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { clearSessionCookie } from '../auth/session-cookie';
import { DeleteAccountDto } from './account.dto';
import { AccountService } from './account.service';

/** The signed-in user's own account (spec #177). */
@Controller('me')
@SkipThrottle(SKIP_ALL_THROTTLERS)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  // The shared per-IP auth budget, as the other account routes.
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard, ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  async delete(
    @CurrentUser() user: User,
    @Body() body: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.account.delete(user, body.email);
    clearSessionCookie(res);
  }
}
