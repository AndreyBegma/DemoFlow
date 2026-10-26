import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import Link from 'next/link';
import { t } from '@/i18n';
import type { Project } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import { RunStatus } from '../projects/run-status';

export const RECENT_LIMIT = 5;

/** The newest projects, in the API's order (newest activity first). */
export function RecentProjects({ projects }: { projects: Project[] | null }) {
  return (
    <Card pad="lg">
      <h2 className="text-lg font-semibold">{t('dashboard.projects.title')}</h2>
      <div className="mt-4">
        {projects === null ? (
          <Banner tone="danger">{t('dashboard.projects.loadFailed')}</Banner>
        ) : projects.length === 0 ? (
          <EmptyState
            title={t('dashboard.projects.empty.title')}
            description={t('dashboard.projects.empty.body')}
            action={
              <Link href="/docs" className="text-sm underline">
                {t('dashboard.projects.empty.docs')}
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col">
              {projects.slice(0, RECENT_LIMIT).map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </ul>
            <Link href="/app/projects" className="text-sm underline">
              {t('dashboard.projects.all')}
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const { lastRun } = project;
  return (
    <li className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0">
      <Link
        href={`/app/projects/${encodeURIComponent(project.id)}`}
        className="break-words font-semibold underline"
      >
        {project.name}
      </Link>
      {lastRun ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <RunStatus status={lastRun.status} />
          <span className="break-words text-ink-2">{lastRun.scenarioName}</span>
          <time
            dateTime={lastRun.startedAt}
            title={formatDate(lastRun.startedAt)}
          >
            {formatRelative(lastRun.startedAt, Date.now()) ??
              formatDate(lastRun.startedAt)}
          </time>
        </p>
      ) : (
        <p className="text-sm text-ink-2">{t('projects.item.noRuns')}</p>
      )}
    </li>
  );
}
