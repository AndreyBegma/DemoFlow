import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import Link from 'next/link';
import { t } from '@/i18n';
import type { StaleScenario } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import { StaleBadge } from '../projects/stale-badge';

export const STALE_LIMIT = 10;

/**
 * The "Stale demos" block of `/app` (spec #363, Decision 4): every broken
 * scenario across the user's projects, or "All passing" for a user who has a
 * schedule. The caller hides it for a user with neither.
 */
export function StaleDemos({ stale }: { stale: StaleScenario[] | null }) {
  const now = Date.now();
  return (
    <Card pad="lg">
      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {t('dashboard.stale.title')}
        {stale && stale.length > 0 ? <StaleBadge count={stale.length} /> : null}
      </h2>
      <div className="mt-4">
        {stale === null ? (
          <Banner tone="danger">{t('dashboard.stale.loadFailed')}</Banner>
        ) : stale.length === 0 ? (
          <p className="text-sm text-ink-2">
            {t('dashboard.stale.allPassing')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {stale.slice(0, STALE_LIMIT).map((row) => {
              const when = formatRelative(row.since, now);
              return (
                <li
                  key={`${row.projectId}:${row.scenarioPath}`}
                  className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0"
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/app/projects/${encodeURIComponent(row.projectId)}`}
                      className="break-words font-semibold underline"
                    >
                      {row.projectName}
                    </Link>
                    <span aria-hidden>·</span>
                    <span className="break-words">{row.scenarioName}</span>
                  </span>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
                    <time
                      dateTime={row.since}
                      title={formatDate(row.since)}
                      suppressHydrationWarning
                    >
                      {when
                        ? t('dashboard.stale.since', { when })
                        : t('dashboard.stale.sinceJustNow')}
                    </time>
                    <Link
                      href={`/app/projects/${encodeURIComponent(row.projectId)}/runs/${encodeURIComponent(row.lastRunId)}`}
                      className="text-ink underline"
                    >
                      {t('dashboard.stale.openRun')}
                    </Link>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
