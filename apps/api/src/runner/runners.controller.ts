import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { RunnerNameDto } from './runner.dto';
import { RunnersService, type RunnerView } from './runners.service';

/** The signed-in user's machines (spec #135): list, rename, revoke. */
@Controller('runners')
@UseGuards(SessionGuard)
export class RunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<{ runners: RunnerView[] }> {
    return { runners: await this.runners.list(user.id) };
  }

  @Patch(':id')
  async rename(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: RunnerNameDto,
  ): Promise<{ runner: RunnerView }> {
    return { runner: await this.runners.rename(user.id, id, body.name) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.runners.revoke(user.id, id);
  }
}
