import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RunsTable } from '@/components/projects/runs-table';
import { StartRun } from '@/components/projects/start-run';
import { t } from '@/i18n';
import { getFirstRuns, getProjects } from '../_data';

export default async function ProjectLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { id } = await params;
  const { status: rawStatus } = await searchParams;
  const status =
    rawStatus === 'passed' || rawStatus === 'failed' ? rawStatus : undefined;
  const [projects, runs] = await Promise.all([
    getProjects(),
    getFirstRuns(id, status),
  ]);
  if (runs === 'not_found') notFound();
  const project = projects?.find((candidate) => candidate.id === id);
  if (projects && !project) notFound();
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
      <header>
        <Link href="/app/projects" className="text-sm text-ink-2 underline">
          {t('projects.back')}
        </Link>
      </header>
      <Card pad="lg">
        <h1 className="break-words text-2xl font-semibold">
          {project?.name ?? t('projects.title')}
        </h1>
        {project?.rootPath ? (
          <div className="mt-1 flex flex-col gap-0.5 text-sm text-ink-2">
            <p className="break-all">
              {t('projects.library.path')}: {project.rootPath}
            </p>
            <p className="break-words">
              {t('projects.library.machine')}:{' '}
              {project.runner?.name ?? t('projects.item.machineRemoved')}
            </p>
          </div>
        ) : null}
      </Card>
      {project ? (
        <StartRun
          projectId={id}
          rootPath={project.rootPath}
          machine={project.runner}
        />
      ) : null}
      <Card pad="lg">
        {runs === 'error' ? (
          <Banner tone="danger">{t('projects.library.pageFailed')}</Banner>
        ) : (
          <RunsTable
            key={status ?? 'all'}
            projectId={id}
            first={runs}
            status={status}
          />
        )}
      </Card>
    </main>
  );
}
