import { Logger } from '@nestjs/common';
import { LogMailer } from './log.mailer';
import type { Mailer } from './mailer';
import { ResendMailer } from './resend.mailer';

export const DEFAULT_MAIL_FROM = 'DemoFlow <no-reply@localhost>';

export interface MailEnv {
  APP_ENV?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_TRANSPORT?: string;
}

/**
 * Which mailer runs (spec #120, Decision 9). `MAIL_TRANSPORT` wins; otherwise
 * a key means Resend, and no key means the log — except in production, which
 * refuses to start rather than lose every email. Tests override the provider
 * with the recording double and never get here.
 */
export function createMailer(env: MailEnv): Mailer {
  const apiKey = env.RESEND_API_KEY?.trim() || undefined;
  const from = env.MAIL_FROM?.trim() || DEFAULT_MAIL_FROM;
  const transport = env.MAIL_TRANSPORT?.trim() || undefined;

  if (transport === 'log') {
    return logMailer();
  }
  if (transport === 'resend' || (transport === undefined && apiKey)) {
    if (!apiKey) {
      throw new Error('MAIL_TRANSPORT=resend needs RESEND_API_KEY.');
    }
    return new ResendMailer(apiKey, from);
  }
  if (transport !== undefined) {
    throw new Error(
      `MAIL_TRANSPORT must be "resend" or "log", not "${transport}".`,
    );
  }
  if (env.APP_ENV === 'production') {
    throw new Error(
      'RESEND_API_KEY is not set, and APP_ENV=production does not fall back ' +
        'to the log mailer. Set RESEND_API_KEY, or MAIL_TRANSPORT=log to print ' +
        'emails to the API log.',
    );
  }
  return logMailer();
}

function logMailer(): Mailer {
  new Logger('Mail').warn(
    'Emails are written to this log, not sent (no RESEND_API_KEY, or MAIL_TRANSPORT=log).',
  );
  return new LogMailer();
}
