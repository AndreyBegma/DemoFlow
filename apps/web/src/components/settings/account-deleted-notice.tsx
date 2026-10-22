'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { t } from '@/i18n';

function Notice() {
  const deleted = useSearchParams().get('deleted') === '1';
  return deleted ? (
    <Banner tone="ok">{t('accountDeletion.deleted')}</Banner>
  ) : null;
}

/**
 * The one line `/` shows after `DELETE /me` (spec #177, Decision 4). Carries
 * its own `Suspense`, so the page around it stays static.
 */
export function AccountDeletedNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
