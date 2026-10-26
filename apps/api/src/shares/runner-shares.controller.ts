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
import type { RunnerContext } from '../runner/runner-token';
import { CurrentRunner, RunnerTokenGuard } from '../runner/runner-token.guard';
import { CreateShareDto, ShareIdParamsDto } from './shares.dto';
import { SharesService, type ShareView } from './shares.service';

/**
 * `demoflow share` and the MCP tool (spec #347, Decision 7): only a run this
 * machine reported. Whether an MCP client may share is checked on the
 * machine, where the project's config is.
 */
@Controller('runner/shares')
@UseGuards(RunnerTokenGuard)
export class RunnerSharesController {
  constructor(private readonly shares: SharesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @CurrentRunner() caller: RunnerContext,
    @Body() body: CreateShareDto,
  ): Promise<ShareView> {
    return this.shares.create(caller.user.id, body, caller.runner.id);
  }

  @Get(':id')
  get(
    @CurrentRunner() caller: RunnerContext,
    @Param() { id }: ShareIdParamsDto,
  ): Promise<ShareView> {
    return this.shares.get(caller.user.id, id, caller.runner.id);
  }
}
