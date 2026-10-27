import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import Link from 'next/link';
import { t } from '@/i18n';
import type { ScenarioHealth as Health } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import { healthOrder } from '@/lib/schedule';
import { StaleBadge } from './stale-badge';

/**
 * Each scenario's last check state on the project page (spec #363, Decision 3):
 * stale rows first, each with a link to its last run. Hidden when the API has
 * no state for any scenario.
 */
export function ScenarioHealth({
  projectId,
  rows,
}: {
  projectId: string;
  rows: Health[];
}) {
  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <section aria-labelledby="scenario-health" className="flex flex-col gap-3">
      <SectionHeader
        title={t('projects.health.title')}
        headingId="scenario-health"
      />
      <Card pad="none">
        <ul aria-label={t('projects.health.title')} className="flex flex-col">
          {healthOrder(rows).map((row) => {
            const when = formatRelative(row.since, now);
            return (
              <li
                key={row.scenarioPath}
                className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium text-ink">
                      {row.scenarioName}
                    </span>
                    {row.state === 'failed' ? <StaleBadge /> : null}
                  </span>
                  <span className="break-all font-mono text-xs text-ink-2">
                    {row.scenarioPath}
                  </span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
                  {row.state === 'failed' ? (
                    <time
                      dateTime={row.since}
                      title={formatDate(row.since)}
                      suppressHydrationWarning
                    >
                      {when
                        ? t('projects.health.stale', { when })
                        : t('projects.health.staleJustNow')}
                    </time>
                  ) : (
                    <span>{t('projects.health.passing')}</span>
                  )}
                  <Link
                    href={`/app/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(row.lastRunId)}`}
                    className="text-ink underline underline-offset-2"
                  >
                    {t('projects.health.lastRun')}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
