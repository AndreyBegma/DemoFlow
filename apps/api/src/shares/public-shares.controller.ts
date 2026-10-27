import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  SKIP_ALL_THROTTLERS,
  THROTTLE_SHARE_UNLOCK,
} from '../auth/auth-throttle';
import { ShareFileQueryDto, UnlockShareDto } from './public-shares.dto';
import { PublicSharesService, type SharePage } from './public-shares.service';

/**
 * A share link, opened without an account (spec #348). No session guard: the
 * token is the only key. Express answers HEAD through the GET routes.
 */
@Controller('s')
@SkipThrottle(SKIP_ALL_THROTTLERS)
export class PublicSharesController {
  constructor(private readonly shares: PublicSharesService) {}

  @Get(':token')
  page(@Param('token') token: string, @Req() req: Request): Promise<SharePage> {
    return this.shares.page(token, req.cookies);
  }

  @Get(':token/file')
  file(
    @Param('token') token: string,
    @Query() { download }: ShareFileQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.shares.serve(req, res, token, 'file', download === '1');
  }

  @Get(':token/poster')
  poster(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.shares.serve(req, res, token, 'poster', false);
  }

  /** 10 attempts per 10 minutes per address and token (Decision 6). */
  @Post(':token/unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_SHARE_UNLOCK]: false })
  unlock(
    @Param('token') token: string,
    @Body() { password }: UnlockShareDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.shares.unlock(token, password, res);
  }
}
