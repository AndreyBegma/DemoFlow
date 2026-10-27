import { Banner } from '@andrewbehma/glass-ui/banner';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { cookies } from 'next/headers';
import { ShareList } from '@/components/shares/share-list';
import { t } from '@/i18n';
import { apiUrl } from '@/lib/session';
import { listShares } from '@/lib/shares-client';

/** The signed-in user's shares and quota (spec #350, Decision 3). */
export default async function SharesPage() {
  const cookie = (await cookies()).toString();
  const result = await listShares({ baseUrl: apiUrl(), cookie });
  return (
    <>
      <PageHeader
        title={t('shares.title')}
        description={t('shares.description')}
      />
      {result.ok ? (
        <ShareList initial={result.data} now={Date.now()} />
      ) : (
        <Banner tone="danger">{t('shares.loadFailed')}</Banner>
      )}
    </>
  );
}
