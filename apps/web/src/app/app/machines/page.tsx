import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { MachineList } from '@/components/machines/machine-list';
import { t } from '@/i18n';
import { getRunners } from '@/lib/session';

export default async function MachinesPage() {
  const runners = await getRunners();
  return (
    <Card pad="lg">
      <h1 className="text-2xl font-semibold">{t('machines.title')}</h1>
      <div className="mt-4">
        {runners ? (
          <MachineList runners={runners} />
        ) : (
          <Banner tone="danger">{t('machines.loadFailed')}</Banner>
        )}
      </div>
    </Card>
  );
}
