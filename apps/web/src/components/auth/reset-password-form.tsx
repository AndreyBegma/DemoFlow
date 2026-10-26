'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/i18n';
import { confirmPasswordReset } from '@/lib/api';
import { type ErrorKey, validateNewPassword } from '@/lib/validation';
import { apiErrorKey, FormError, TextField } from './form-parts';

interface State {
  error?: ErrorKey;
  formError?: ErrorKey;
  linkInvalid: boolean;
  done: boolean;
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    async (_previous: State, data: FormData): Promise<State> => {
      const password = String(data.get('password') ?? '');
      const error = validateNewPassword(password);
      if (error) return { error, linkInvalid: false, done: false };
      const result = await confirmPasswordReset(token, password);
      if (result.ok) return { linkInvalid: false, done: true };
      // The password passed client validation, so a refusal is the link.
      if (result.error === 'invalid') return { linkInvalid: true, done: false };
      return {
        formError: apiErrorKey(result.error),
        linkInvalid: false,
        done: false,
      };
    },
    { linkInvalid: false, done: false },
  );

  if (state.done) {
    return (
      <>
        <Banner tone="ok" title={t('auth.reset.doneTitle')}>
          {t('auth.reset.doneBody')}
        </Banner>
        <Link
          href="/sign-in"
          className={buttonClassName({ variant: 'solid', full: true })}
        >
          {t('auth.reset.signIn')}
        </Link>
      </>
    );
  }

  if (state.linkInvalid) {
    return <InvalidResetLink />;
  }

  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <FormError messageKey={state.formError} />
      <TextField
        name="password"
        type="password"
        label={t('auth.fields.newPassword')}
        autoComplete="new-password"
        hint={t('auth.fields.passwordHint')}
        error={state.error}
      />
      <Button type="submit" variant="solid" full disabled={pending}>
        {pending ? t('auth.reset.submitting') : t('auth.reset.submit')}
      </Button>
    </form>
  );
}

export function InvalidResetLink() {
  return (
    <>
      <Banner tone="warn" title={t('auth.reset.invalidTitle')}>
        {t('auth.reset.invalidBody')}
      </Banner>
      <Link
        href="/forgot-password"
        className={buttonClassName({ variant: 'solid', full: true })}
      >
        {t('auth.reset.requestNew')}
      </Link>
    </>
  );
}
