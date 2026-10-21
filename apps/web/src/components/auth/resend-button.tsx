'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { useState } from 'react';
import { t } from '@/i18n';
import { resendVerification } from '@/lib/api';
import { apiErrorKey } from './form-parts';

type Status = 'idle' | 'sending' | 'sent' | 'failed';

/** Asks the API for a fresh verification email for the signed-in user. */
export function ResendButton({
  label,
  sentLabel,
}: {
  label: string;
  sentLabel: string;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorKey, setErrorKey] = useState(apiErrorKey('unknown'));

  async function resend() {
    setStatus('sending');
    const result = await resendVerification();
    if (result.ok) {
      setStatus('sent');
      return;
    }
    setErrorKey(apiErrorKey(result.error));
    setStatus('failed');
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="glass"
        size="sm"
        disabled={status === 'sending'}
        onClick={resend}
      >
        {status === 'sending' ? t('app.shell.resending') : label}
      </Button>
      <p aria-live="polite" className="text-xs text-ink-2">
        {status === 'sent' ? sentLabel : null}
        {status === 'failed' ? t(errorKey) : null}
      </p>
    </div>
  );
}
