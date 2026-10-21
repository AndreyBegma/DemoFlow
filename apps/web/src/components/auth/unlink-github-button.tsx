'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { unlinkGithub } from '@/lib/api';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey, FormError } from './form-parts';

/**
 * Unlinks GitHub, then re-renders the settings page from the server. Disabled,
 * with the reason beside it, when the account has no password to fall back to.
 */
export function UnlinkGithubButton({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | undefined>();
  const reasonId = 'unlink-github-reason';

  async function submit() {
    setPending(true);
    setError(undefined);
    const result = await unlinkGithub();
    if (!result.ok) {
      setError(apiErrorKey(result.error, 'auth.errors.unknown'));
      setPending(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <FormError messageKey={error} />
      <div>
        <Button
          type="button"
          variant="danger"
          disabled={!hasPassword || pending}
          aria-describedby={hasPassword ? undefined : reasonId}
          onClick={submit}
        >
          {pending
            ? t('app.settings.github.unlinking')
            : t('app.settings.github.unlink')}
        </Button>
      </div>
      {hasPassword ? null : (
        <p id={reasonId} className="text-sm text-ink-2">
          {t('app.settings.github.needsPassword')}
        </p>
      )}
    </div>
  );
}
