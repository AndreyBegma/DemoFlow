import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { notFound } from 'next/navigation';
import { RunPlayback } from '@/components/player/run-playback';
import { DeleteRun } from '@/components/projects/delete-run';
import { RunAgain } from '@/components/projects/run-again';
import { RunBreadcrumbs } from '@/components/projects/run-breadcrumbs';
import {
  RunDetails,
  RunFailureBanner,
} from '@/components/projects/run-details';
import { RunStatus } from '@/components/projects/run-status';
import { t } from '@/i18n';
import { formatDate } from '@/lib/format-date';
import { formatDuration } from '@/lib/format-duration';
import { formatRelative } from '@/lib/format-relative';
import { canRunAgain } from '@/lib/launch';
import { getProjects, getRunDetail } from '../../../_data';

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  const detail = await getRunDetail(runId);
  if (detail === 'not_found') notFound();
  if (detail === 'error') {
    return (
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
        <Banner tone="danger">{t('runPage.pageFailed')}</Banner>
      </main>
    );
  }
  const { run, project, machine } = detail;
  if (project.id !== id) notFound();
  const relative = formatRelative(run.startedAt, Date.now());
  const currentProject =
    (await getProjects())?.find((p) => p.id === id) ?? null;
  const againState = canRunAgain({
    project: currentProject,
    machine,
    scenarioPath: run.scenarioPath,
  });
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
      <RunBreadcrumbs
        projectId={project.id}
        projectName={project.name}
        runName={run.scenarioName}
      />
      <Card pad="lg">
        <h1 className="break-words text-2xl font-semibold">
          {t('runPage.title', { name: run.scenarioName })}
        </h1>
        <div className="mt-4">
          <KeyValueList
            columns={2}
            items={[
              {
                key: 'scenario',
                label: t('runPage.metadata.scenario'),
                value: run.scenarioName,
              },
              {
                key: 'path',
                label: t('runPage.metadata.path'),
                value: run.scenarioPath,
              },
              {
                key: 'status',
                label: t('runPage.metadata.status'),
                value: <RunStatus status={run.status} />,
              },
              {
                key: 'when',
                label: t('runPage.metadata.when'),
                value: (
                  <time dateTime={run.startedAt}>
                    {formatDate(run.startedAt)} (
                    {relative ?? t('runPage.metadata.justNow')})
                  </time>
                ),
              },
              {
                key: 'duration',
                label: t('runPage.metadata.duration'),
                value: formatDuration(run.durationMs),
              },
              {
                key: 'failedStep',
                label: t('runPage.metadata.failedStep'),
                value:
                  run.failedStep === null
                    ? t('runPage.metadata.noFailedStep')
                    : t('runPage.metadata.step', {
                        number: run.failedStep + 1,
                      }),
              },
              {
                key: 'machine',
                label: t('runPage.metadata.machine'),
                value: machine?.name ?? t('projects.item.machineRemoved'),
              },
              {
                key: 'cliVersion',
                label: t('runPage.metadata.cliVersion'),
                value: run.cliVersion,
              },
            ]}
          />
        </div>
        <DeleteRun
          runId={run.id}
          projectId={project.id}
          filesRemain={
            run.formats.length > 0 && run.artifactsDeletedAt === null
          }
        />
      </Card>
      <RunFailureBanner failure={run.failure} />
      {machine !== null && againState !== 'hidden' ? (
        <RunAgain
          projectId={project.id}
          scenarioId={run.scenarioPath}
          scenarioName={run.scenarioName}
          machineName={machine.name}
          offline={againState === 'offline'}
        />
      ) : null}
      <Card pad="lg">
        <RunPlayback
          runId={run.id}
          formats={run.formats}
          machine={machine}
          artifactsDeletedAt={run.artifactsDeletedAt}
        />
      </Card>
      <RunDetails stages={run.stages} renders={run.renders} />
    </main>
  );
}
