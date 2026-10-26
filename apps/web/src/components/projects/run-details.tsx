import { Card } from '@andrewbehma/glass-ui/card';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import type { RunDetailView, RunStageName } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import { formatDuration } from '@/lib/format-duration';
import { stageStatus } from '@/lib/status';
import { formatLabel } from './format-choice';

const STAGE_ORDER: RunStageName[] = [
  'readiness',
  'execution',
  'verification',
  'recording',
  'rendering',
  'storage',
];

/**
 * The reason a failed run failed. The message is plain text, never markup, and
 * sits on a solid surface in monospace so it stays readable over the glass
 * panel (spec #374, Decision 4).
 */
export function RunFailure({ failure }: { failure: RunDetailView['failure'] }) {
  if (failure === null) return null;
  return (
    <Card
      variant="content"
      pad="sm"
      role="alert"
      className="border-l-4 border-l-danger"
    >
      <p className="text-sm font-medium text-danger">
        {t('runPage.failure.title', {
          stage: t(`runPage.stages.names.${failure.stage}`),
        })}
      </p>
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-ink">
        {failure.message}
      </pre>
    </Card>
  );
}

/** The run's stage statuses as pills; nothing for a run that reported none. */
export function RunStages({ stages }: Pick<RunDetailView, 'stages'>) {
  if (stages === null) return null;
  return (
    <section aria-labelledby="run-stages">
      <h2 id="run-stages" className="text-sm font-semibold">
        {t('runPage.stages.title')}
      </h2>
      <Card variant="content" pad="sm" className="mt-2">
        <ul className="flex flex-col gap-1.5">
          {STAGE_ORDER.map((stage) => (
            <li
              key={stage}
              className="flex items-center justify-between gap-3 font-mono text-xs"
            >
              <span>{t(`runPage.stages.names.${stage}`)}</span>
              <StatusIndicator status={stageStatus(stages[stage])} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** The files the run rendered; nothing for a run that reported none. */
export function RunFiles({ renders }: Pick<RunDetailView, 'renders'>) {
  if (renders === null) return null;
  return (
    <section aria-labelledby="run-files">
      <SectionHeader title={t('runPage.files.title')} headingId="run-files" />
      <Card pad="md">
        {renders.length === 0 ? (
          <p>{t('runPage.files.none')}</p>
        ) : (
          <KeyValueList
            columns={1}
            items={renders.map((render) => ({
              key: render.format,
              label: formatLabel(render.format),
              value: [
                t('runPage.files.resolution', {
                  width: render.width,
                  height: render.height,
                }),
                formatBytes(render.sizeBytes),
                formatDuration(render.durationMs),
              ].join(' · '),
            }))}
          />
        )}
      </Card>
    </section>
  );
}
