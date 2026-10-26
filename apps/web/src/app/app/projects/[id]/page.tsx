import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { notFound } from 'next/navigation';
import { MachinePill } from '@/components/projects/machine-pill';
import { ProjectPath } from '@/components/projects/project-path';
import { RunsTable } from '@/components/projects/runs-table';
import { StartRun } from '@/components/projects/start-run';
import { CrumbName } from '@/components/shell/crumb-names';
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
    <>
      {project ? <CrumbName segment={id} name={project.name} /> : null}
      <PageHeader
        title={
          <span className="break-words">
            {project?.name ?? t('projects.title')}
          </span>
        }
        status={
          project?.rootPath ? <MachinePill machine={project.runner} /> : null
        }
        description={
          project?.rootPath ? (
            <ProjectPath path={project.rootPath} />
          ) : project ? (
            t('projects.item.noFolder')
          ) : null
        }
      />
      {project ? (
        <StartRun
          projectId={id}
          rootPath={project.rootPath}
          machine={project.runner}
        />
      ) : null}
      <section aria-labelledby="project-runs" className="flex flex-col gap-3">
        <SectionHeader
          title={t('projects.library.runsTitle')}
          headingId="project-runs"
        />
        <Card pad="md">
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
      </section>
    </>
  );
}
