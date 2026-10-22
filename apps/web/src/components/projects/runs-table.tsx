'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import Link from 'next/link';
import { useState } from 'react';
import { t } from '@/i18n';
import {
  listProjectRuns,
  type ProjectRun,
  type ProjectRunsPage,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatDuration } from '@/lib/format-duration';
import { RunStatus } from './run-status';

export function RunsTable({
  projectId,
  first,
}: {
  projectId: string;
  first: ProjectRunsPage;
}) {
  const [runs, setRuns] = useState<ProjectRun[]>(first.runs);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (runs.length === 0) {
    return (
      <EmptyState
        title={t('projects.library.empty.title')}
        description={t('projects.library.empty.body')}
      />
    );
  }

  async function loadMore() {
    if (cursor === null) return;
    setBusy(true);
    setFailed(false);
    const result = await listProjectRuns(projectId, cursor);
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setRuns((current) => [...current, ...result.data.runs]);
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="text-ink-2">
            <tr>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('projects.library.columns.scenario')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('projects.library.columns.status')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('projects.library.columns.when')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('projects.library.columns.duration')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('projects.library.columns.formats')}
              </th>
              <th scope="col" className="py-2 font-normal">
                {t('projects.library.columns.failedStep')}
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-t border-current/10">
                <td className="py-3 pr-4 align-top">
                  <Link
                    href={`/app/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.id)}`}
                    className="break-words font-medium underline"
                  >
                    {run.scenarioName}
                  </Link>
                  <div className="break-all text-xs text-ink-2">
                    {run.scenarioPath}
                  </div>
                </td>
                <td className="py-3 pr-4 align-top">
                  <RunStatus status={run.status} />
                </td>
                <td className="py-3 pr-4 align-top">
                  <time dateTime={run.startedAt}>
                    {formatDate(run.startedAt)}
                  </time>
                </td>
                <td className="py-3 pr-4 align-top">
                  {formatDuration(run.durationMs)}
                </td>
                <td className="py-3 pr-4 align-top">
                  {run.formats.length === 0 ? (
                    <span className="text-ink-2">
                      {t('projects.library.noFormats')}
                    </span>
                  ) : (
                    <span>{run.formats.join(', ')}</span>
                  )}
                </td>
                <td className="py-3 align-top">
                  {run.failedStep === null
                    ? t('projects.library.noFailedStep')
                    : t('projects.library.step', {
                        number: run.failedStep + 1,
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed ? (
        <Banner tone="danger">{t('projects.library.loadFailed')}</Banner>
      ) : null}
      {cursor === null ? null : (
        <div>
          <Button
            type="button"
            variant="glass"
            disabled={busy}
            onClick={loadMore}
          >
            {busy
              ? t('projects.library.loadingMore')
              : t('projects.library.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
