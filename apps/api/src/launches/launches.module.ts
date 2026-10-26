import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RunnerModule } from '../runner/runner.module';
import { LaunchesController } from './launches.controller';
import { LaunchesService } from './launches.service';

/**
 * Website-started runs (spec #247, ADR-0016): the scenario list and the
 * launch, both over the runner socket. Nothing is stored.
 */
@Module({
  imports: [AuthModule, RunnerModule],
  controllers: [LaunchesController],
  providers: [LaunchesService],
  exports: [LaunchesService],
})
export class LaunchesModule {}
