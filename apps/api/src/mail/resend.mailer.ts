import { Mailer, type MailMessage } from './mailer';

const RESEND_URL = 'https://api.resend.com/emails';

export class ResendMailer extends Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Resend refused the email (${response.status}): ${detail}`,
      );
    }
  }
}
