import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMailer } from './mail-transport';
import { Mailer } from './mailer';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createMailer({
          APP_ENV: config.get<string>('APP_ENV'),
          RESEND_API_KEY: config.get<string>('RESEND_API_KEY'),
          MAIL_FROM: config.get<string>('MAIL_FROM'),
          MAIL_TRANSPORT: config.get<string>('MAIL_TRANSPORT'),
        }),
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
