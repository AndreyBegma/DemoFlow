import type { MessageKey } from '@/i18n';

/** Keys of the form-error strings; none takes a parameter. */
export type ErrorKey = Extract<MessageKey, `auth.errors.${string}`>;

// Mirrors the API's DTOs (spec #120); the server stays the authority.
const EMAIL_MAX = 254;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): ErrorKey | undefined {
  const email = value.trim();
  if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
    return 'auth.errors.email';
  }
  return undefined;
}

/** Length in code points, as the API counts it. */
export function validateNewPassword(value: string): ErrorKey | undefined {
  const length = [...value].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    return 'auth.errors.password';
  }
  return undefined;
}

export function validateCurrentPassword(value: string): ErrorKey | undefined {
  return value.length === 0 ? 'auth.errors.passwordRequired' : undefined;
}
