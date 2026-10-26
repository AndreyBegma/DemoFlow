import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/i18n';
import {
  type AddProjectState,
  type FolderErrorKey,
  type FolderInspection,
  inspectionResult,
  SCENARIOS_SHOWN,
} from '@/lib/add-project';

/** Where the allowed folders are documented (spec #380). */
const ALLOW_DOCS = '/docs/runner#allowed-folders';

/**
 * What the machine found in the folder (spec #379, Decision 3). It shows only
 * the inspection's fields — never a file's content (Decision 5).
 */
export function InspectionPanel({
  state,
  onCreateConfig,
}: {
  state: AddProjectState;
  onCreateConfig: () => void;
}) {
  switch (state.phase) {
    case 'idle':
    case 'done':
      return null;
    case 'inspecting':
      return (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner size="sm" label={null} />
          {t('projects.add.inspecting')}
        </p>
      );
    case 'failed':
      return <FolderError error={state.error} existingId={null} />;
  }
  const result = inspectionResult(state.inspection);
  return (
    <div className="flex flex-col gap-3">
      {result === 'found' ? (
        <Found inspection={state.inspection} />
      ) : result === 'no-config' ? (
        <Banner
          tone="info"
          action={
            <Button
              type="button"
              size="sm"
              disabled={state.phase !== 'inspected'}
              onClick={onCreateConfig}
            >
              {state.phase === 'initialising'
                ? t('projects.add.creatingConfig')
                : t('projects.add.createConfig')}
            </Button>
          }
        >
          {t('projects.add.noConfig')}
        </Banner>
      ) : (
        <Banner tone="warn">{t('projects.add.configInvalid')}</Banner>
      )}
      {state.created && state.created.length > 0 ? (
        <Banner
          tone="ok"
          title={t('projects.add.created', {
            files: state.created.join(', '),
          })}
        >
          {t('projects.add.createdHint')}
        </Banner>
      ) : null}
      {state.error ? (
        <FolderError error={state.error} existingId={state.existingId} />
      ) : null}
    </div>
  );
}

function Found({ inspection }: { inspection: FolderInspection }) {
  const { scenarios } = inspection;
  const shown = scenarios.slice(0, SCENARIOS_SHOWN).map(({ name }) => name);
  const more = scenarios.length - shown.length;
  return (
    <Card variant="content" pad="sm" className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          <CircleCheck aria-hidden size={16} className="text-ok" />
          {t('projects.add.found')}
        </span>
        <span className="text-ink-2">
          {scenarios.length === 1
            ? t('projects.add.scenarioCountOne')
            : t('projects.add.scenarioCount', { count: scenarios.length })}
        </span>
      </p>
      <KeyValueList
        dense
        items={[
          {
            key: 'folder',
            label: t('projects.add.folderName'),
            value: inspection.rootPath,
          },
          {
            key: 'scenarios',
            label: t('projects.add.scenarios'),
            value:
              shown.length === 0
                ? t('projects.add.noScenarios')
                : [
                    shown.join(' · '),
                    more > 0
                      ? ` ${t('projects.add.scenarioMore', { count: more })}`
                      : '',
                  ].join(''),
          },
          ...(inspection.githubUrl
            ? [
                {
                  key: 'github',
                  label: t('projects.add.github'),
                  value: (
                    <a
                      href={inspection.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {inspection.githubUrl.replace(/^https:\/\//, '')}
                    </a>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}

function FolderError({
  error,
  existingId,
}: {
  error: FolderErrorKey;
  existingId: string | null;
}) {
  if (error === 'projects.add.errors.pathNotAllowed') {
    return (
      <Banner
        tone="warn"
        action={
          <Link href={ALLOW_DOCS} className="text-sm underline">
            {t('projects.add.allowDocs')}
          </Link>
        }
      >
        {t(error)}{' '}
        <code className="font-mono">{t('projects.add.allowCommand')}</code>
      </Banner>
    );
  }
  return (
    <Banner
      tone="danger"
      action={
        existingId ? (
          <Link
            href={`/app/projects/${encodeURIComponent(existingId)}`}
            className="text-sm underline"
          >
            {t('projects.add.openExisting')}
          </Link>
        ) : undefined
      }
    >
      {t(error)}
    </Banner>
  );
}
