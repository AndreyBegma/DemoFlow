'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { useRouter } from 'next/navigation';
import { useActionState, useId } from 'react';
import { t } from '@/i18n';
import { type UnlockOutcome, unlockShare } from '@/lib/share-page';

const MESSAGES = {
  'wrong-password': 'sharePage.locked.wrongPassword',
  'rate-limited': 'sharePage.locked.rateLimited',
  error: 'sharePage.locked.failed',
} as const;

type Failure = keyof typeof MESSAGES;

/**
 * The password form of a protected share (spec #351, Decision 4). A right
 * password sets the unlock cookie; the page then fetches the share again.
 */
export function UnlockForm({ token }: { token: string }) {
  const router = useRouter();
  const id = useId();
  const [failure, action, pending] = useActionState(
    async (_previous: Failure | null, data: FormData) => {
      const outcome: UnlockOutcome = await unlockShare(
        token,
        String(data.get('password') ?? ''),
      );
      if (outcome === 'unlocked' || outcome === 'changed') {
        // An expired or removed share shows its own page after the refresh.
        router.refresh();
        return null;
      }
      return outcome;
    },
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      {failure ? <Banner tone="danger">{t(MESSAGES[failure])}</Banner> : null}
      <Field label={t('sharePage.locked.password')} htmlFor={id}>
        <Input
          id={id}
          name="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={failure === 'wrong-password' ? true : undefined}
          required
        />
      </Field>
      <Button type="submit" full disabled={pending}>
        {pending
          ? t('sharePage.locked.submitting')
          : t('sharePage.locked.submit')}
      </Button>
    </form>
  );
}
