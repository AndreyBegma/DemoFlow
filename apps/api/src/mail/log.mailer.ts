import { Logger } from '@nestjs/common';
import { Mailer, type MailMessage } from './mailer';

/** Below production without a Resend key: each email goes to the API log. */
export class LogMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  async send(message: MailMessage): Promise<void> {
    this.logger.log(
      `to=${message.to} subject="${message.subject}" link=${message.link ?? '-'}`,
    );
  }
}
