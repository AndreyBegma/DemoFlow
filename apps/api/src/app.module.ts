import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { ChecksModule } from './checks/checks.module';
import { ClockModule } from './common/clock.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { LaunchesModule } from './launches/launches.module';
import { MailModule } from './mail/mail.module';
import { ProjectsModule } from './projects/projects.module';
import { RunnerModule } from './runner/runner.module';
import { SharesModule } from './shares/shares.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    ClockModule,
    MailModule,
    AuthModule,
    RunnerModule,
    ProjectsModule,
    VideosModule,
    LaunchesModule,
    SharesModule,
    ChecksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
