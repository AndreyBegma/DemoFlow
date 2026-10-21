export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** The one link the message carries, if any. The log mailer prints it. */
  link?: string;
}

/** Sends account emails. Resend, the API log, or a test recording. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}
