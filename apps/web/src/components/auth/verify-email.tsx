'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { verifyEmail } from '@/lib/api';
import { apiErrorKey } from './form-parts';
import { ResendButton } from './resend-button';

type Status = 'pending' | 'verified' | 'invalid' | 'failed';

export function VerifyEmail({
  token,
  signedIn,
}: {
  token: string;
  signedIn: boolean;
}) {
  const [status, setStatus] = useState<Status>(token ? 'pending' : 'invalid');
  const [failure, setFailure] = useState(apiErrorKey('unknown'));
  // A token works once; strict mode runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    verifyEmail(token).then((result) => {
      if (result.ok) {
        setStatus('verified');
      } else if (result.error === 'invalid') {
        setStatus('invalid');
      } else {
        setFailure(apiErrorKey(result.error));
        setStatus('failed');
      }
    });
  }, [token]);

  if (status === 'pending') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
        <Spinner size="sm" label={null} />
        {t('auth.verify.pending')}
      </p>
    );
  }

  if (status === 'verified') {
    return (
      <>
        <Banner tone="ok" title={t('auth.verify.doneTitle')}>
          {t('auth.verify.doneBody')}
        </Banner>
        <Link
          href="/app"
          className={buttonClassName({ variant: 'solid', full: true })}
        >
          {t('auth.verify.toApp')}
        </Link>
      </>
    );
  }

  if (status === 'failed') {
    return <Banner tone="danger">{t(failure)}</Banner>;
  }

  return (
    <>
      <Banner tone="warn" title={t('auth.verify.invalidTitle')}>
        {t('auth.verify.invalidBody')}
      </Banner>
      {signedIn ? (
        <ResendButton
          label={t('auth.verify.resend')}
          sentLabel={t('auth.verify.resent')}
        />
      ) : (
        <Link
          href="/sign-in"
          className={buttonClassName({ variant: 'solid', full: true })}
        >
          {t('auth.verify.signIn')}
        </Link>
      )}
    </>
  );
}
