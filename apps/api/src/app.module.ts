import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { ClockModule } from './common/clock.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { MailModule } from './mail/mail.module';

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
  ],
  controllers: [HealthController],
})
export class AppModule {}
