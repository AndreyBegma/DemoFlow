import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RunnerModule } from '../runner/runner.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { VideoRelay } from './video-relay.service';

/**
 * A run's page and its video through the runner relay (spec #191, ADR-0009
 * §1). Nothing is stored: the bytes come from the Runner on every request.
 */
@Module({
  imports: [AuthModule, RunnerModule],
  controllers: [RunsController],
  providers: [RunsService, VideoRelay],
})
export class VideosModule {}
