import { Banner } from '@andrewbehma/glass-ui/banner';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { notFound } from 'next/navigation';
import { RunPlayback } from '@/components/player/run-playback';
import { DeleteRun } from '@/components/projects/delete-run';
import { formatList } from '@/components/projects/format-choice';
import { MachinePill } from '@/components/projects/machine-pill';
import { RunAgain } from '@/components/projects/run-again';
import {
  RunFailure,
  RunFiles,
  RunStages,
} from '@/components/projects/run-details';
import { RunStatus } from '@/components/projects/run-status';
import { ShareButton } from '@/components/shares/share-button';
import { CrumbName } from '@/components/shell/crumb-names';
import { t } from '@/i18n';
import { formatDate } from '@/lib/format-date';
import { formatDuration } from '@/lib/format-duration';
import { formatRelative } from '@/lib/format-relative';
import { canRunAgain, runAgainFormats } from '@/lib/launch';
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
    return <Banner tone="danger">{t('runPage.pageFailed')}</Banner>;
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
  const details = (
    <>
      <KeyValueList
        columns={1}
        dense
        items={[
          {
            key: 'status',
            label: t('runPage.metadata.status'),
            value: <RunStatus status={run.status} />,
          },
          {
            key: 'scenario',
            label: t('runPage.metadata.scenario'),
            value: <span className="break-words">{run.scenarioName}</span>,
          },
          {
            key: 'path',
            label: t('runPage.metadata.path'),
            value: (
              <span className="break-all font-mono text-xs">
                {run.scenarioPath}
              </span>
            ),
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
            value: <MachinePill machine={machine} />,
          },
          {
            key: 'formats',
            label: t('runPage.metadata.formats'),
            value:
              run.formats.length > 0
                ? formatList(run.formats)
                : t('runPage.metadata.noFormats'),
          },
          {
            key: 'cliVersion',
            label: t('runPage.metadata.cliVersion'),
            value: <span className="font-mono text-xs">{run.cliVersion}</span>,
          },
        ]}
      />
      <RunFailure failure={run.failure} />
      <RunStages stages={run.stages} />
    </>
  );
  return (
    <>
      <CrumbName segment={project.id} name={project.name} />
      <CrumbName segment={run.id} name={run.scenarioName} />
      <PageHeader
        title={
          <span className="break-words">
            {t('runPage.title', { name: run.scenarioName })}
          </span>
        }
        description={project.name}
        actions={
          <ShareButton
            run={{
              id: run.id,
              formats: run.formats,
              renders: run.renders,
              artifactsDeletedAt: run.artifactsDeletedAt,
            }}
            machine={machine}
          />
        }
      />
      <RunPlayback
        runId={run.id}
        formats={run.formats}
        machine={machine}
        artifactsDeletedAt={run.artifactsDeletedAt}
        details={details}
        runAgain={
          machine !== null && againState !== 'hidden' ? (
            <RunAgain
              projectId={project.id}
              scenarioId={run.scenarioPath}
              scenarioName={run.scenarioName}
              machineName={machine.name}
              offline={againState === 'offline'}
              formats={runAgainFormats(run.formats, machine.runOptions)}
            />
          ) : null
        }
        deleteRun={
          <DeleteRun
            runId={run.id}
            projectId={project.id}
            filesRemain={
              run.formats.length > 0 && run.artifactsDeletedAt === null
            }
          />
        }
      />
      <RunFiles renders={run.renders} />
    </>
  );
}
