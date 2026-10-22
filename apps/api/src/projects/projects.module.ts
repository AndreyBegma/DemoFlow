import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RunnerModule } from '../runner/runner.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RunnerRunsController } from './runner-runs.controller';

/** Projects and the demo library (spec #178): metadata only, never video. */
@Module({
  imports: [AuthModule, RunnerModule],
  controllers: [ProjectsController, RunnerRunsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
