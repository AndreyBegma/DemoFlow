'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { t } from '@/i18n';
import { signIn } from '@/lib/api';
import {
  type ErrorKey,
  validateCurrentPassword,
  validateEmail,
} from '@/lib/validation';
import { apiErrorKey, FormError, TextField } from './form-parts';

interface State {
  email: string;
  errors: { email?: ErrorKey; password?: ErrorKey };
  formError?: ErrorKey;
  done: boolean;
}

/** `next` is an in-app path the page already checked with `safeReturnTo`. */
export function SignInForm({ next }: { next?: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    async (_previous: State, data: FormData): Promise<State> => {
      const email = String(data.get('email') ?? '').trim();
      const password = String(data.get('password') ?? '');
      const errors = {
        email: validateEmail(email),
        password: validateCurrentPassword(password),
      };
      if (errors.email || errors.password) {
        return { email, errors, done: false };
      }
      const result = await signIn(email, password);
      if (!result.ok) {
        return {
          email,
          errors: {},
          formError: apiErrorKey(result.error, 'auth.errors.credentials'),
          done: false,
        };
      }
      router.replace(next ?? '/app');
      router.refresh();
      return { email, errors: {}, done: true };
    },
    { email: '', errors: {}, done: false },
  );

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
        autoComplete="current-password"
        error={state.errors.password}
      />
      <Button
        type="submit"
        variant="solid"
        full
        disabled={pending || state.done}
      >
        {pending || state.done
          ? t('auth.signIn.submitting')
          : t('auth.signIn.submit')}
      </Button>
    </form>
  );
}
