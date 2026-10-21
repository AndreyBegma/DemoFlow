'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { signOut } from '@/lib/api';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    await signOut();
    router.replace('/sign-in');
    router.refresh();
  }

  return (
    <Button type="button" variant="glass" disabled={pending} onClick={submit}>
      {pending ? t('app.shell.signingOut') : t('app.shell.signOut')}
    </Button>
  );
}
