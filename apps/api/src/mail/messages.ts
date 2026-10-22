import type { MailMessage } from './mailer';

export function verifyEmailMessage(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Verify your DemoFlow email',
    link,
    text: [
      'Confirm this address to finish setting up your DemoFlow account:',
      '',
      link,
      '',
      'The link works once and expires in 24 hours. If you did not sign up, ignore this email.',
    ].join('\n'),
  };
}

export function resetPasswordMessage(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Reset your DemoFlow password',
    link,
    text: [
      'Choose a new password for your DemoFlow account:',
      '',
      link,
      '',
      'The link works once and expires in 1 hour. Resetting signs you out everywhere.',
      'If you did not ask for this, ignore this email: your password stays as it is.',
    ].join('\n'),
  };
}

/** Sent instead of a verification email when the address already has an account. */
export function alreadyRegisteredMessage(to: string): MailMessage {
  return {
    to,
    subject: 'Someone tried to sign up with your email',
    text: [
      'Someone tried to create a DemoFlow account with this address, which already has one.',
      '',
      'If it was you, sign in instead, or reset your password if you have forgotten it.',
      'If it was not you, no action is needed: nothing was changed.',
    ].join('\n'),
  };
}
