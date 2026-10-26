import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { MachinesSummary } from '@/components/dashboard/machines-summary';
import { RecentProjects } from '@/components/dashboard/recent-projects';
import { t } from '@/i18n';
import { overviewStats } from '@/lib/overview-stats';
import { getRunners } from '@/lib/session';
import { getProjects } from './projects/_data';

export default async function AppPage() {
  const [projects, runners] = await Promise.all([getProjects(), getRunners()]);
  const stats = projects ? overviewStats(projects) : null;
  const unavailable = t('dashboard.stats.unavailable');
  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
      />
      <section
        aria-label={t('dashboard.title')}
        className="grid grid-cols-1 gap-3 tablet:grid-cols-3"
      >
        <StatTile
          label={t('dashboard.stats.projects')}
          value={stats?.projects ?? unavailable}
        />
        <StatTile
          label={t('dashboard.stats.runs')}
          value={stats?.runs ?? unavailable}
        />
        <StatTile
          label={t('dashboard.stats.failing')}
          value={stats?.failing ?? unavailable}
          hint={t('dashboard.stats.failingHint')}
        />
      </section>
      <div className="grid grid-cols-1 gap-6 desktop:grid-cols-3">
        <div className="desktop:col-span-2">
          <RecentProjects projects={projects} />
        </div>
        <MachinesSummary runners={runners} />
      </div>
    </>
  );
}
