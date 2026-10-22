import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { RunnerConnections } from '../runner/runner-connections.service';
import { MAX_STREAMS_PER_RUNNER } from '../runner/runner-socket';
import { parseRange } from './byte-range';
import { RunVideoParamsDto } from './runs.dto';
import {
  liveMachine,
  type RunPage,
  RunsService,
  runError,
} from './runs.service';
import { VideoRelay } from './video-relay.service';

/** A run and its video, played from the machine that recorded it (spec #191). */
@Controller('runs')
@UseGuards(SessionGuard)
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly connections: RunnerConnections,
    private readonly relay: VideoRelay,
  ) {}

  @Get(':id')
  view(@CurrentUser() user: User, @Param('id') id: string): Promise<RunPage> {
    return this.runs.page(user.id, id);
  }

  /** Every check before anything goes to the Runner (Decisions 1–2). */
  @Get(':id/video/:format')
  async video(
    @CurrentUser() user: User,
    @Param() { id, format }: RunVideoParamsDto,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.runs.find(user.id, id);
    if (!run.formats.includes(format)) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    const machine = liveMachine(run);
    if (!machine) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-removed');
    }
    if (!this.connections.isOnline(machine.id)) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-offline');
    }
    if (this.relay.openTo(machine.id) >= MAX_STREAMS_PER_RUNNER) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-busy');
    }
    this.relay.open({
      runnerId: machine.id,
      runId: run.id,
      format,
      range: parseRange(range),
      res,
    });
  }
}
