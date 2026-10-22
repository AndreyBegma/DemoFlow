import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { RunnerContext } from '../runner/runner-token';
import { CurrentRunner, RunnerTokenGuard } from '../runner/runner-token.guard';
import { RunReportDto } from './projects.dto';
import { ProjectsService } from './projects.service';

/** Where a paired machine reports a finished `demoflow run` (spec #178, Decision 3). */
@Controller('runner/runs')
@UseGuards(RunnerTokenGuard)
export class RunnerRunsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  report(
    @CurrentRunner() caller: RunnerContext,
    @Body() body: RunReportDto,
  ): Promise<{ projectId: string; runId: string }> {
    return this.projects.report(caller.runner, body);
  }
}
