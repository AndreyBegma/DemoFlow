import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import {
  CreateProjectDto,
  RunsPageQueryDto,
  UpdateProjectDto,
} from './projects.dto';
import {
  ProjectsService,
  type ProjectView,
  type RunsPage,
} from './projects.service';

/** The signed-in user's projects and their run library (spec #178). */
@Controller('projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<{ projects: ProjectView[] }> {
    return { projects: await this.projects.list(user.id) };
  }

  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() body: CreateProjectDto,
  ): Promise<{ project: ProjectView }> {
    return { project: await this.projects.create(user.id, body) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: UpdateProjectDto,
  ): Promise<{ project: ProjectView }> {
    return { project: await this.projects.update(user.id, id, body) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.projects.remove(user.id, id);
  }

  @Get(':id/runs')
  runs(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query: RunsPageQueryDto,
  ): Promise<RunsPage> {
    return this.projects.runs(user.id, id, query.cursor, query.status);
  }
}
