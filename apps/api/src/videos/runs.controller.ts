import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
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
import { ArtifactsService } from './artifacts.service';
import { parseRange } from './byte-range';
import { RunIdParamsDto, RunVideoParamsDto } from './runs.dto';
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
    private readonly artifacts: ArtifactsService,
  ) {}

  @Get(':id')
  view(@CurrentUser() user: User, @Param('id') id: string): Promise<RunPage> {
    return this.runs.page(user.id, id);
  }

  /**
   * Deletes the run's metadata; its files on the machine stay and nothing is
   * sent to the Runner (spec #280, Decisions 1–4).
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: User,
    @Param() { id }: RunIdParamsDto,
  ): Promise<void> {
    return this.runs.remove(user.id, id);
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
    // Spec #233, Decision 6: before the machine state.
    if (run.artifactsDeletedAt) {
      throw runError(HttpStatus.GONE, 'artifacts-deleted');
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

  /**
   * Deletes the run's directory on its machine; the run stays (spec #233,
   * Decisions 1–3). Idempotent: an already deleted run is 204 at once.
   */
  @Delete(':id/artifacts')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteArtifacts(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<void> {
    const run = await this.runs.find(user.id, id);
    if (run.artifactsDeletedAt) {
      return;
    }
    const machine = liveMachine(run);
    if (!machine) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-removed');
    }
    if (!this.connections.isOnline(machine.id)) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-offline');
    }
    await this.artifacts.delete(machine.id, run.id);
  }
}
