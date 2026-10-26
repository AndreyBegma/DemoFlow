import { ShareNotice } from '@/components/share-page/share-notice';
import { t } from '@/i18n';

/** An unknown token (spec #351, Decision 1). Next answers 404 and `noindex`. */
export default function ShareNotFound() {
  return (
    <ShareNotice
      title={t('sharePage.notFound.title')}
      body={t('sharePage.notFound.body')}
    />
  );
}
