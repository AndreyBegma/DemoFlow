import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RunnerModule } from '../runner/runner.module';
import { ShareStorageModule } from '../shares/share-storage';
import { FoldersController } from './folders/folders.controller';
import { FoldersService } from './folders/folders.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RunnerRunsController } from './runner-runs.controller';

/** Projects and the demo library (spec #178): metadata only, never video. */
@Module({
  imports: [AuthModule, RunnerModule, ShareStorageModule],
  // `projects/folders/*` before `projects/:id/*`.
  controllers: [FoldersController, ProjectsController, RunnerRunsController],
  providers: [ProjectsService, FoldersService],
})
export class ProjectsModule {}
