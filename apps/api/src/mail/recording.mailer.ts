import { Mailer, type MailMessage } from './mailer';

/** The test double: keeps every message instead of sending it. */
export class RecordingMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  to(address: string): MailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }
}
