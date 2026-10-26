import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { CreateShareDto, ShareIdParamsDto } from './shares.dto';
import {
  type SharesList,
  SharesService,
  type ShareView,
} from './shares.service';

/** The owner's share links (spec #347, ADR-0019). */
@Controller('shares')
@UseGuards(SessionGuard)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  /** 202: the row exists, the upload runs in the background. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @CurrentUser() user: User,
    @Body() body: CreateShareDto,
  ): Promise<ShareView> {
    return this.shares.create(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: User): Promise<SharesList> {
    return this.shares.list(user.id);
  }

  @Get(':id')
  get(
    @CurrentUser() user: User,
    @Param() { id }: ShareIdParamsDto,
  ): Promise<ShareView> {
    return this.shares.get(user.id, id);
  }

  @Post(':id/extend')
  @HttpCode(HttpStatus.OK)
  extend(
    @CurrentUser() user: User,
    @Param() { id }: ShareIdParamsDto,
  ): Promise<ShareView> {
    return this.shares.extend(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: User,
    @Param() { id }: ShareIdParamsDto,
  ): Promise<void> {
    return this.shares.remove(user.id, id);
  }
}
