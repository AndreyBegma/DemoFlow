import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import Link from 'next/link';
import { MachineList } from '@/components/machines/machine-list';
import { t } from '@/i18n';
import { getRunners } from '@/lib/session';

export default async function MachinesPage() {
  const runners = await getRunners();
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6">
      <header>
        <Link href="/app" className="text-sm text-ink-2 underline">
          {t('machines.back')}
        </Link>
      </header>
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
    </main>
  );
}
