import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import {
  HealthService,
  type HealthView,
  type StaleView,
} from './health/health.service';
import { PutScheduleDto } from './schedules/schedules.dto';
import {
  type ProjectSchedules,
  SchedulesService,
  type ScheduleView,
} from './schedules/schedules.service';

/**
 * A project's check schedule and the per-scenario state (spec #362, API).
 * Another user's project is `404`, as on every project route.
 */
@Controller()
@UseGuards(SessionGuard)
export class ChecksController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly health: HealthService,
  ) {}

  @Get('projects/:id/schedule')
  schedule(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ProjectSchedules> {
    return this.schedules.get(user.id, id);
  }

  @Put('projects/:id/schedule')
  put(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: PutScheduleDto,
  ): Promise<ScheduleView> {
    return this.schedules.put(user.id, id, dto);
  }

  @Delete('projects/:id/schedule')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.schedules.remove(user.id, id);
  }

  @Get('projects/:id/health')
  projectHealth(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<HealthView[]> {
    return this.health.project(user.id, id);
  }

  @Get('checks/stale')
  stale(@CurrentUser() user: User): Promise<StaleView[]> {
    return this.health.stale(user.id);
  }
}
