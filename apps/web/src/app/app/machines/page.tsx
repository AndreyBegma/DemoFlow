import { Banner } from '@andrewbehma/glass-ui/banner';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { MachineList } from '@/components/machines/machine-list';
import { t } from '@/i18n';
import { getRunners } from '@/lib/session';

export default async function MachinesPage() {
  const runners = await getRunners();
  return (
    <>
      <PageHeader
        title={t('machines.title')}
        description={t('machines.description')}
      />
      {runners ? (
        <MachineList runners={runners} />
      ) : (
        <Banner tone="danger">{t('machines.loadFailed')}</Banner>
      )}
    </>
  );
}
