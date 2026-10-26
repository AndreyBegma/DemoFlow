'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { useActionState } from 'react';
import { t } from '@/i18n';
import { requestPasswordReset } from '@/lib/api';
import { type ErrorKey, validateEmail } from '@/lib/validation';
import { apiErrorKey, FormError, TextField } from './form-parts';

interface State {
  email: string;
  error?: ErrorKey;
  formError?: ErrorKey;
  done: boolean;
}

async function submit(_previous: State, data: FormData): Promise<State> {
  const email = String(data.get('email') ?? '').trim();
  const error = validateEmail(email);
  if (error) return { email, error, done: false };
  const result = await requestPasswordReset(email);
  if (!result.ok) {
    return { email, formError: apiErrorKey(result.error), done: false };
  }
  return { email, done: true };
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(submit, {
    email: '',
    done: false,
  });

  if (state.done) {
    return <Banner tone="ok">{t('auth.forgot.done')}</Banner>;
  }

  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <FormError messageKey={state.formError} />
      <TextField
        name="email"
        type="email"
        label={t('auth.fields.email')}
        autoComplete="email"
        defaultValue={state.email}
        error={state.error}
      />
      <Button type="submit" variant="solid" full disabled={pending}>
        {pending ? t('auth.forgot.submitting') : t('auth.forgot.submit')}
      </Button>
    </form>
  );
}
