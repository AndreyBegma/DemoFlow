import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { MachinesSummary } from '@/components/dashboard/machines-summary';
import { RecentProjects } from '@/components/dashboard/recent-projects';
import { StaleDemos } from '@/components/dashboard/stale-demos';
import { t } from '@/i18n';
import type { Project } from '@/lib/api';
import { overviewStats } from '@/lib/overview-stats';
import { getRunners } from '@/lib/session';
import { getProjectSchedules, getProjects, getStale } from './projects/_data';

/**
 * Whether any bound project has a schedule, so an empty stale list reads "All
 * passing" (spec #363, Decision 4). Asked only when nothing is stale.
 */
async function hasSchedule(projects: Project[] | null): Promise<boolean> {
  const bound = (projects ?? []).filter((project) => project.rootPath !== null);
  const schedules = await Promise.all(
    bound.map((project) => getProjectSchedules(project.id)),
  );
  return schedules.some((entry) => entry?.site || entry?.config);
}

export default async function AppPage() {
  const [projects, runners, stale] = await Promise.all([
    getProjects(),
    getRunners(),
    getStale(),
  ]);
  const showStale =
    stale === null || stale.length > 0 || (await hasSchedule(projects));
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
      {showStale ? <StaleDemos stale={stale} /> : null}
      <div className="grid grid-cols-1 gap-6 desktop:grid-cols-3">
        <div className="desktop:col-span-2">
          <RecentProjects projects={projects} />
        </div>
        <MachinesSummary runners={runners} />
      </div>
    </>
  );
}
