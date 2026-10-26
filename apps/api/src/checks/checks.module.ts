import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LaunchesModule } from '../launches/launches.module';
import { RunnerModule } from '../runner/runner.module';
import { ChecksController } from './checks.controller';
import { HealthService } from './health/health.service';
import { CheckScheduler } from './schedules/check-scheduler';
import { SchedulesService } from './schedules/schedules.service';

/**
 * Scheduled checks on the website side (spec #362, ADR-0021): the schedules,
 * the scheduler that starts a check pass when one is due, and the
 * per-scenario stale state.
 */
@Module({
  imports: [AuthModule, RunnerModule, LaunchesModule],
  controllers: [ChecksController],
  providers: [SchedulesService, CheckScheduler, HealthService],
})
export class ChecksModule {}
