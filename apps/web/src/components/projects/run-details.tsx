import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { t } from '@/i18n';
import type { RunDetailView, RunStageName } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import { formatDuration } from '@/lib/format-duration';

const STAGE_ORDER: RunStageName[] = [
  'readiness',
  'execution',
  'verification',
  'recording',
  'rendering',
  'storage',
];

const FORMAT_LABELS = [
  'mp4',
  'webm',
  'mp4-vertical',
  'webm-vertical',
  'gif',
  'gif-vertical',
] as const;

function formatLabel(format: string): string {
  const known = FORMAT_LABELS.find((candidate) => candidate === format);
  return known ? t(`runPage.formats.${known}`) : format;
}

/** The reason a failed run failed; the message is plain text, never markup. */
export function RunFailureBanner({
  failure,
}: {
  failure: RunDetailView['failure'];
}) {
  if (failure === null) return null;
  return (
    <Banner tone="danger">
      <p className="font-medium">
        {t('runPage.failure.title', {
          stage: t(`runPage.stages.names.${failure.stage}`),
        })}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words">{failure.message}</p>
    </Banner>
  );
}

/** Stage statuses and rendered files; renders nothing for a run that reported neither. */
export function RunDetails({
  stages,
  renders,
}: Pick<RunDetailView, 'stages' | 'renders'>) {
  if (stages === null && renders === null) return null;
  return (
    <Card pad="lg">
      {stages !== null ? (
        <section aria-labelledby="run-stages">
          <h2 id="run-stages" className="text-lg font-semibold">
            {t('runPage.stages.title')}
          </h2>
          <div className="mt-3">
            <KeyValueList
              columns={2}
              items={STAGE_ORDER.map((stage) => ({
                key: stage,
                label: t(`runPage.stages.names.${stage}`),
                value: (
                  <span
                    className={
                      stages[stage] === 'failed'
                        ? 'text-red-600 dark:text-red-400'
                        : undefined
                    }
                  >
                    {t(`runPage.stages.statuses.${stages[stage]}`)}
                  </span>
                ),
              }))}
            />
          </div>
        </section>
      ) : null}
      {renders !== null ? (
        <section
          aria-labelledby="run-files"
          className={stages !== null ? 'mt-6' : undefined}
        >
          <h2 id="run-files" className="text-lg font-semibold">
            {t('runPage.files.title')}
          </h2>
          {renders.length === 0 ? (
            <p className="mt-3">{t('runPage.files.none')}</p>
          ) : (
            <div className="mt-3">
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
            </div>
          )}
        </section>
      ) : null}
    </Card>
  );
}
