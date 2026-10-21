'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { useId } from 'react';
import { t } from '@/i18n';
import type { ApiError } from '@/lib/api';
import type { ErrorKey } from '@/lib/validation';

/** The message for a failed call; `invalid` is worded by the form. */
export function apiErrorKey(
  error: ApiError,
  invalid: ErrorKey = 'auth.errors.invalid',
): ErrorKey {
  if (error === 'rate_limited') return 'auth.errors.rateLimited';
  if (error === 'invalid') return invalid;
  return 'auth.errors.unknown';
}

export function TextField({
  name,
  label,
  type = 'text',
  autoComplete,
  defaultValue,
  error,
  hint,
}: {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password';
  autoComplete: string;
  defaultValue?: string;
  error?: ErrorKey;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      error={error ? t(error) : undefined}
    >
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        required
      />
    </Field>
  );
}

/** A form-level failure, announced by the banner's alert role. */
export function FormError({ messageKey }: { messageKey?: ErrorKey }) {
  if (!messageKey) return null;
  return <Banner tone="danger">{t(messageKey)}</Banner>;
}
