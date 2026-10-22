import { Logger } from '@nestjs/common';
import { LogMailer } from './log.mailer';
import { createMailer } from './mail-transport';
import { ResendMailer } from './resend.mailer';

describe('createMailer', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses Resend when a key is set', () => {
    expect(createMailer({ RESEND_API_KEY: 're_123' })).toBeInstanceOf(
      ResendMailer,
    );
    expect(
      createMailer({ APP_ENV: 'production', RESEND_API_KEY: 're_123' }),
    ).toBeInstanceOf(ResendMailer);
  });

  it('falls back to the log below production, with a warning', () => {
    expect(createMailer({ APP_ENV: 'development' })).toBeInstanceOf(LogMailer);
    expect(createMailer({ RESEND_API_KEY: '  ' })).toBeInstanceOf(LogMailer);
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('refuses to start in production without a key, naming RESEND_API_KEY', () => {
    expect(() => createMailer({ APP_ENV: 'production' })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it('lets MAIL_TRANSPORT override the selection', () => {
    expect(
      createMailer({ APP_ENV: 'production', MAIL_TRANSPORT: 'log' }),
    ).toBeInstanceOf(LogMailer);
    expect(
      createMailer({ RESEND_API_KEY: 're_123', MAIL_TRANSPORT: 'log' }),
    ).toBeInstanceOf(LogMailer);
    expect(() => createMailer({ MAIL_TRANSPORT: 'resend' })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => createMailer({ MAIL_TRANSPORT: 'smtp' })).toThrow(
      /MAIL_TRANSPORT/,
    );
  });
});
