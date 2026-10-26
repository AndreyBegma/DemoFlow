'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Input } from '@andrewbehma/glass-ui/field';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CellLabel, stacked } from '@/components/projects/stacked-rows';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import { type Runner, renameRunner, revokeRunner } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import { machineStatus } from '@/lib/status';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey } from '../auth/form-parts';

const NAME_MAX = 64;
const REFRESH_MS = 15_000;

type Failure = 'machines.errors.name' | 'machines.errors.notFound';

export function MachineList({ runners }: { runners: Runner[] }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Runner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | ErrorKey | undefined>();
  // Null until mounted, so the server render and hydration agree.
  const [now, setNow] = useState<number | null>(null);

  // Online status by polling (spec #151, Decision 11): refetch while the tab is
  // visible. router.refresh() keeps client state, so an open rename survives.
  useEffect(() => {
    setNow(Date.now());
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      router.refresh();
      setNow(Date.now());
    };
    const sync = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (document.visibilityState === 'visible') {
        timer = setInterval(tick, REFRESH_MS);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
      sync();
    };
    sync();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [router]);

  if (runners.length === 0) {
    return (
      <EmptyState
        title={t('machines.empty.title')}
        description={t('machines.empty.body')}
        action={
          <div className="flex flex-col items-center gap-2">
            <code className="rounded-control bg-hover px-3 py-2 text-sm">
              {t('machines.empty.command')}
            </code>
            <span className="text-sm text-ink-2">
              {t('machines.empty.afterLogin')}
            </span>
            <code className="rounded-control bg-hover px-3 py-2 text-sm">
              {t('machines.startCommand')}
            </code>
          </div>
        }
      />
    );
  }

  async function rename(runner: Runner, value: string) {
    const name = value.trim();
    if (name.length < 1 || [...name].length > NAME_MAX) {
      setError('machines.errors.name');
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await renameRunner(runner.id, name);
    setBusy(false);
    if (!result.ok) {
      setError(
        result.status === 404
          ? 'machines.errors.notFound'
          : apiErrorKey(result.error),
      );
      if (result.status === 404) router.refresh();
      return;
    }
    setRenaming(null);
    router.refresh();
  }

  async function revoke(runner: Runner) {
    setBusy(true);
    setError(undefined);
    const result = await revokeRunner(runner.id);
    setBusy(false);
    setRevoking(null);
    // A 404 means it is already revoked: the refreshed list says so.
    if (!result.ok && result.status !== 404) {
      setError(apiErrorKey(result.error));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner tone="danger">{t(error)}</Banner> : null}
      {runners.some((runner) => runner.online) ? null : (
        <Banner tone="info">
          {t('machines.noneOnline')}{' '}
          <code className="rounded-control bg-hover px-2 py-1 text-sm">
            {t('machines.startCommand')}
          </code>
        </Banner>
      )}
      <Card pad="sm">
        <Table className={stacked.table}>
          <TableHead className={stacked.head}>
            <tr>
              <TableCell head scope="col">
                {t('machines.columns.name')}
              </TableCell>
              <TableCell head scope="col">
                {t('machines.columns.os')}
              </TableCell>
              <TableCell head scope="col">
                {t('machines.columns.cliVersion')}
              </TableCell>
              <TableCell head scope="col">
                {t('machines.columns.status')}
              </TableCell>
              <TableCell head scope="col">
                {t('machines.columns.lastSeen')}
              </TableCell>
              <TableCell head scope="col">
                <span className="sr-only">{t('machines.columns.actions')}</span>
              </TableCell>
            </tr>
          </TableHead>
          <tbody className={stacked.body}>
            {runners.map((runner) => (
              <TableRow key={runner.id} className={stacked.row}>
                <TableCell className={stacked.lead}>
                  {renaming === runner.id ? (
                    <RenameForm
                      runner={runner}
                      busy={busy}
                      onSave={(value) => rename(runner, value)}
                      onCancel={() => {
                        setRenaming(null);
                        setError(undefined);
                      }}
                    />
                  ) : (
                    <>
                      <span className="break-words font-medium text-ink">
                        {runner.name}
                      </span>
                      <span className="block text-xs text-ink-2">
                        {t('machines.paired', {
                          date: formatDate(runner.createdAt),
                        })}{' '}
                        ·{' '}
                        {runner.lastUsedAt
                          ? t('machines.lastUsed', {
                              date: formatDate(runner.lastUsedAt),
                            })
                          : t('machines.neverUsed')}
                      </span>
                    </>
                  )}
                </TableCell>
                <TableCell className={`${stacked.cell} break-words`}>
                  <CellLabel>{t('machines.columns.os')}</CellLabel>
                  {runner.os}
                </TableCell>
                <TableCell className={`${stacked.cell} font-mono text-xs`}>
                  <CellLabel>{t('machines.columns.cliVersion')}</CellLabel>
                  {runner.cliVersion}
                </TableCell>
                <TableCell className={stacked.cell}>
                  <CellLabel>{t('machines.columns.status')}</CellLabel>
                  <StatusIndicator status={machineStatus(runner.online)} />
                </TableCell>
                <TableCell className={stacked.cell}>
                  <CellLabel>{t('machines.columns.lastSeen')}</CellLabel>
                  <LastSeen runner={runner} now={now} />
                </TableCell>
                <TableCell className={stacked.cell}>
                  <div className="flex gap-2 md:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRenaming(runner.id);
                        setError(undefined);
                      }}
                    >
                      {t('machines.rename')}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => setRevoking(runner)}
                    >
                      {t('machines.revoke')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('machines.revokeTitle', { name: revoking?.name ?? '' })}
        consequence={t('machines.revokeBody')}
        verb={t('machines.revoke')}
        busy={busy}
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
      />
    </div>
  );
}

function LastSeen({ runner, now }: { runner: Runner; now: number | null }) {
  if (!runner.lastSeenAt) {
    return <span className="text-ink-2">{t('machines.lastSeen.never')}</span>;
  }
  const when =
    now === null
      ? formatDate(runner.lastSeenAt)
      : (formatRelative(runner.lastSeenAt, now) ??
        t('machines.lastSeen.justNow'));
  return (
    <div className="flex min-w-0 flex-col">
      <time dateTime={runner.lastSeenAt} title={formatDate(runner.lastSeenAt)}>
        {when}
      </time>
      {runner.lastSeenIp ? (
        <span className="text-xs text-ink-2 break-all">
          {t('machines.lastSeen.ip', { ip: runner.lastSeenIp })}
        </span>
      ) : null}
    </div>
  );
}

function RenameForm({
  runner,
  busy,
  onSave,
  onCancel,
}: {
  runner: Runner;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(runner.name);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <Input
        aria-label={t('machines.renameLabel')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
        required
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('machines.saving') : t('machines.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          {t('machines.cancel')}
        </Button>
      </div>
    </form>
  );
}
