'use client';

import { SelectionBar } from '@andrewbehma/glass-ui';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import {
  deleteProjectRuns,
  listProjectRuns,
  type ProjectRun,
  type ProjectRunsPage,
  type RunStatusFilter,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatDuration } from '@/lib/format-duration';
import { bulkDeleteOutcome, DELETE_RUNS_MAX } from '@/lib/run-delete';
import { artifactStatus } from '@/lib/status';
import { RunStatus } from './run-status';
import { CellLabel, stacked } from './stacked-rows';

const FILTERS: { status: RunStatusFilter | undefined; label: string }[] = [
  { status: undefined, label: 'projects.library.filter.all' },
  { status: 'passed', label: 'projects.library.filter.passed' },
  { status: 'failed', label: 'projects.library.filter.failed' },
];

export function RunsTable({
  projectId,
  first,
  status,
}: {
  projectId: string;
  first: ProjectRunsPage;
  status?: RunStatusFilter;
}) {
  const [runs, setRuns] = useState<ProjectRun[]>(first.runs);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<
    'partlyGone' | 'notFound' | 'error' | null
  >(null);
  const [alreadyGone, setAlreadyGone] = useState(0);

  if (runs.length === 0 && cursor === null && status === undefined) {
    return (
      <EmptyState
        title={t('projects.library.empty.title')}
        description={t('projects.library.empty.body')}
      />
    );
  }

  const base = `/app/projects/${encodeURIComponent(projectId)}`;
  const filter = (
    <SegmentedControl aria-label={t('projects.library.filter.label')} size="sm">
      {FILTERS.map((option) => (
        <SegmentedControlItem
          key={option.label}
          active={option.status === status}
          layoutId="runs-status-filter"
        >
          <Link
            href={option.status ? `${base}?status=${option.status}` : base}
            aria-current={option.status === status ? 'true' : undefined}
            className="flex items-center justify-center px-3 text-sm"
          >
            {t(option.label as 'projects.library.filter.all')}
          </Link>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );

  if (runs.length === 0 && cursor === null && status !== undefined) {
    return (
      <div className="flex flex-col gap-4">
        <div>{filter}</div>
        <EmptyState title={t(`projects.library.emptyFiltered.${status}`)} />
      </div>
    );
  }

  async function loadMore() {
    if (cursor === null) return;
    setBusy(true);
    setFailed(false);
    const result = await listProjectRuns(projectId, cursor, undefined, status);
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setRuns((current) => [...current, ...result.data.runs]);
    setCursor(result.data.nextCursor);
  }

  const allSelected = runs.length > 0 && runs.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(runs.map((r) => r.id)));
  }

  async function deleteSelected() {
    const ids = [...selected];
    setDeleting(true);
    setNotice(null);
    const result = await deleteProjectRuns(projectId, ids);
    setDeleting(false);
    setConfirming(false);
    const outcome = bulkDeleteOutcome(result, ids.length);
    if (outcome.kind === 'deleted') {
      const gone = new Set(ids);
      setRuns((current) => current.filter((r) => !gone.has(r.id)));
      setSelected(new Set());
      if (outcome.alreadyGone > 0) {
        setAlreadyGone(outcome.alreadyGone);
        setNotice('partlyGone');
      }
      router.refresh();
      return;
    }
    setNotice(outcome.kind);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>{filter}</div>
      <Table className={stacked.table}>
        <TableHead className={stacked.head}>
          <tr>
            <TableCell head scope="col" className="w-10">
              <Checkbox
                aria-label={t('projects.library.select.all')}
                checked={allSelected}
                indeterminate={selected.size > 0 && !allSelected}
                onChange={toggleAll}
              />
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.scenario')}
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.status')}
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.when')}
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.duration')}
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.formats')}
            </TableCell>
            <TableCell head scope="col">
              {t('projects.library.columns.failedStep')}
            </TableCell>
          </tr>
        </TableHead>
        <tbody className={stacked.body}>
          {runs.map((run) => {
            const artifacts = artifactStatus(run);
            return (
              <TableRow key={run.id} className={stacked.row}>
                <TableCell className={stacked.control}>
                  <Checkbox
                    aria-label={t('projects.library.select.row', {
                      name: run.scenarioName,
                    })}
                    checked={selected.has(run.id)}
                    onChange={() => toggle(run.id)}
                  />
                </TableCell>
                <TableCell className={stacked.lead}>
                  <Link
                    href={`/app/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.id)}`}
                    className="break-words font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {run.scenarioName}
                  </Link>
                  <div className="break-all font-mono text-xs text-ink-2">
                    {run.scenarioPath}
                  </div>
                </TableCell>
                <TableCell className={stacked.cell}>
                  <CellLabel>{t('projects.library.columns.status')}</CellLabel>
                  <RunStatus status={run.status} />
                </TableCell>
                <TableCell className={`${stacked.cell} whitespace-nowrap`}>
                  <CellLabel>{t('projects.library.columns.when')}</CellLabel>
                  <time dateTime={run.startedAt}>
                    {formatDate(run.startedAt)}
                  </time>
                </TableCell>
                <TableCell className={`${stacked.cell} tabular-nums`}>
                  <CellLabel>
                    {t('projects.library.columns.duration')}
                  </CellLabel>
                  {formatDuration(run.durationMs)}
                </TableCell>
                <TableCell className={stacked.cell}>
                  <CellLabel>{t('projects.library.columns.formats')}</CellLabel>
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {run.formats.length === 0 ? (
                      <span className="text-ink-2">
                        {t('projects.library.noFormats')}
                      </span>
                    ) : (
                      <span>{run.formats.join(', ')}</span>
                    )}
                    {artifacts ? <StatusIndicator status={artifacts} /> : null}
                  </span>
                </TableCell>
                <TableCell className={stacked.cell}>
                  <CellLabel>
                    {t('projects.library.columns.failedStep')}
                  </CellLabel>
                  {run.failedStep === null
                    ? t('projects.library.noFailedStep')
                    : t('projects.library.step', {
                        number: run.failedStep + 1,
                      })}
                </TableCell>
              </TableRow>
            );
          })}
        </tbody>
      </Table>
      {failed ? (
        <Banner tone="danger">{t('projects.library.loadFailed')}</Banner>
      ) : null}
      {notice === 'partlyGone' ? (
        <Banner tone="info">
          {t('projects.library.bulkDelete.partlyGone', {
            count: alreadyGone,
          })}
        </Banner>
      ) : null}
      {notice === 'notFound' ? (
        <Banner tone="danger">{t('projects.errors.notFound')}</Banner>
      ) : null}
      {notice === 'error' ? (
        <Banner tone="danger">{t('auth.errors.unknown')}</Banner>
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
      <SelectionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        clearLabel={t('projects.library.select.clear')}
        label={(count) =>
          count > DELETE_RUNS_MAX
            ? t('projects.library.select.countMax', {
                count,
                max: DELETE_RUNS_MAX,
              })
            : t('projects.library.select.count', { count })
        }
        actions={[
          {
            id: 'delete',
            label: t('projects.library.bulkDelete.action'),
            tone: 'danger',
            disabled: selected.size > DELETE_RUNS_MAX,
            onSelect: () => setConfirming(true),
          },
        ]}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          selected.size === 1
            ? t('projects.library.bulkDelete.titleOne')
            : t('projects.library.bulkDelete.title', { count: selected.size })
        }
        consequence={t('projects.library.bulkDelete.consequence')}
        verb={t('projects.library.bulkDelete.confirm')}
        cancelLabel={t('projects.library.bulkDelete.cancel')}
        busy={deleting}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  );
}
