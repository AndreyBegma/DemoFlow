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
import { PrismaService } from '../database/prisma.service';
import { RunnerConnections } from '../runner/runner-connections.service';
import { runError } from '../videos/runs.service';
import { StartLaunchDto } from './launches.dto';
import {
  LaunchesService,
  type LaunchTarget,
  type LaunchView,
  type ScenarioList,
} from './launches.service';

/**
 * A project's scenarios, and a run of one started and cancelled from the
 * website (spec #247, ADR-0016). Every check comes before anything goes to
 * the Runner.
 */
@Controller('projects')
@UseGuards(SessionGuard)
export class LaunchesController {
  constructor(
    private readonly launches: LaunchesService,
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
  ) {}

  @Get(':id/scenarios')
  async scenarios(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ScenarioList> {
    return this.launches.listScenarios(await this.target(user.id, id));
  }

  @Post(':id/launch')
  @HttpCode(HttpStatus.ACCEPTED)
  async start(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() { scenarioId, formats }: StartLaunchDto,
  ): Promise<{ launch: LaunchView }> {
    const target = await this.target(user.id, id);
    // Spec #325, Decision 3: after `runner-offline`, before `runner-busy`.
    if (
      formats !== undefined &&
      !this.connections.runOptions(target.runnerId).includes('formats')
    ) {
      throw runError(HttpStatus.CONFLICT, 'runner-outdated');
    }
    return { launch: await this.launches.start(target, scenarioId, formats) };
  }

  /**
   * Ownership only: a launch whose machine went away keeps its state until
   * the machine is back or the grace ends (spec #284, Decision 2).
   */
  @Get(':id/launch')
  async latest(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ launch: LaunchView | null }> {
    await this.owned(user.id, id);
    return { launch: this.launches.latest(id) };
  }

  @Delete(':id/launch')
  @HttpCode(HttpStatus.ACCEPTED)
  async cancel(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ launch: LaunchView }> {
    await this.owned(user.id, id);
    return { launch: this.launches.cancel(id) };
  }

  /** Decision 3, in order; `runner-busy` is the service's, at the start. */
  private async target(userId: string, id: string): Promise<LaunchTarget> {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: {
        id: true,
        rootPath: true,
        runner: { select: { id: true, revokedAt: true } },
      },
    });
    if (!project) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
    if (project.rootPath === null) {
      throw runError(HttpStatus.CONFLICT, 'project-unbound');
    }
    if (!project.runner || project.runner.revokedAt !== null) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-removed');
    }
    if (!this.connections.isOnline(project.runner.id)) {
      throw runError(HttpStatus.SERVICE_UNAVAILABLE, 'runner-offline');
    }
    return {
      projectId: project.id,
      runnerId: project.runner.id,
      rootPath: project.rootPath,
    };
  }

  private async owned(userId: string, id: string): Promise<void> {
    const count = await this.prisma.project.count({ where: { id, userId } });
    if (count !== 1) {
      throw runError(HttpStatus.NOT_FOUND, 'not-found');
    }
  }
}
