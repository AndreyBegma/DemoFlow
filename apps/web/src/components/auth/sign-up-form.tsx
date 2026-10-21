'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { useActionState } from 'react';
import { t } from '@/i18n';
import { signUp } from '@/lib/api';
import {
  type ErrorKey,
  validateEmail,
  validateNewPassword,
} from '@/lib/validation';
import { apiErrorKey, FormError, TextField } from './form-parts';

interface State {
  email: string;
  errors: { email?: ErrorKey; password?: ErrorKey };
  formError?: ErrorKey;
  done: boolean;
}

async function submit(_previous: State, data: FormData): Promise<State> {
  const email = String(data.get('email') ?? '').trim();
  const password = String(data.get('password') ?? '');
  const errors = {
    email: validateEmail(email),
    password: validateNewPassword(password),
  };
  if (errors.email || errors.password) return { email, errors, done: false };
  const result = await signUp(email, password);
  if (!result.ok) {
    return {
      email,
      errors: {},
      formError: apiErrorKey(result.error),
      done: false,
    };
  }
  return { email, errors: {}, done: true };
}

export function SignUpForm() {
  const [state, action, pending] = useActionState(submit, {
    email: '',
    errors: {},
    done: false,
  });

  if (state.done) {
    return (
      <Banner tone="ok" title={t('auth.signUp.doneTitle')}>
        {t('auth.signUp.doneBody', { email: state.email })}
      </Banner>
    );
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
        error={state.errors.email}
      />
      <TextField
        name="password"
        type="password"
        label={t('auth.fields.password')}
        autoComplete="new-password"
        hint={t('auth.fields.passwordHint')}
        error={state.errors.password}
      />
      <Button type="submit" full disabled={pending}>
        {pending ? t('auth.signUp.submitting') : t('auth.signUp.submit')}
      </Button>
    </form>
  );
}
