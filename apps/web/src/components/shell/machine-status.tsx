import { Badge } from '@andrewbehma/glass-ui/badge';
import Link from 'next/link';
import { t } from '@/i18n';
import type { Runner } from '@/lib/api';
import { onlineCount } from '@/lib/overview-stats';

/** Up to this many machines get a row each; more collapse to a summary. */
export const MACHINE_ROWS = 3;

const ROW =
  'flex min-h-8 items-center gap-2 rounded-control px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink';

/**
 * The paired machines at the bottom of the sidebar (spec #373, Decision 4):
 * a row per machine with its connection, a summary past three, or a way to
 * pair the first one. Read once per navigation by the layout; no polling.
 */
export function MachineStatus({ runners }: { runners: Runner[] | null }) {
  return (
    <section
      aria-label={t('app.shell.status.title')}
      className="flex flex-col gap-0.5 border-t border-line pt-2"
    >
      {runners === null ? (
        <p className="px-3 text-sm text-ink-3">
          {t('app.shell.status.failed')}
        </p>
      ) : runners.length === 0 ? (
        <Link href="/docs/runner" className={ROW}>
          {t('app.shell.status.pair')}
        </Link>
      ) : runners.length > MACHINE_ROWS ? (
        <Link href="/app/machines" className={ROW}>
          <Badge
            dot
            tone={onlineCount(runners) > 0 ? 'ok' : 'neutral'}
            aria-hidden="true"
            className="size-2"
          />
          {t('app.shell.status.summary', {
            count: runners.length,
            online: onlineCount(runners),
          })}
        </Link>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {runners.map((runner) => (
            <li key={runner.id}>
              <Link href="/app/machines" className={ROW}>
                <Badge
                  dot
                  tone={runner.online ? 'ok' : 'neutral'}
                  aria-hidden="true"
                  className="size-2 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{runner.name}</span>
                <span className="sr-only">
                  {runner.online
                    ? t('machines.status.online')
                    : t('machines.status.offline')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
