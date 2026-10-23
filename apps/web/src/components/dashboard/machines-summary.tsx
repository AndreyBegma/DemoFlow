import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import Link from 'next/link';
import { t } from '@/i18n';
import type { Runner } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';

/** Every paired machine with its connection. */
export function MachinesSummary({ runners }: { runners: Runner[] | null }) {
  return (
    <Card pad="lg">
      <h2 className="text-lg font-semibold">{t('dashboard.machines.title')}</h2>
      <div className="mt-4">
        {runners === null ? (
          <Banner tone="danger">{t('dashboard.machines.loadFailed')}</Banner>
        ) : runners.length === 0 ? (
          <EmptyState
            title={t('dashboard.machines.empty.title')}
            description={t('dashboard.machines.empty.body')}
            action={
              <Link href="/docs/runner" className="text-sm underline">
                {t('dashboard.machines.empty.docs')}
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col">
              {runners.map((runner) => (
                <MachineRow key={runner.id} runner={runner} />
              ))}
            </ul>
            <Link href="/app/machines" className="text-sm underline">
              {t('dashboard.machines.manage')}
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

function MachineRow({ runner }: { runner: Runner }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-current/10 py-3 first:border-t-0 first:pt-0">
      <span className="min-w-0 break-words font-semibold">{runner.name}</span>
      <span className="flex items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2.5 rounded-full ${runner.online ? 'bg-green-500' : 'bg-gray-400'}`}
          />
          {runner.online
            ? t('machines.status.online')
            : t('machines.status.offline')}
        </span>
        <span className="text-ink-2">
          {runner.lastSeenAt ? (
            <time
              dateTime={runner.lastSeenAt}
              title={formatDate(runner.lastSeenAt)}
            >
              {formatRelative(runner.lastSeenAt, Date.now()) ??
                t('machines.lastSeen.justNow')}
            </time>
          ) : (
            t('machines.lastSeen.never')
          )}
        </span>
      </span>
    </li>
  );
}
