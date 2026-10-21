'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Input } from '@andrewbehma/glass-ui/field';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { type Runner, renameRunner, revokeRunner } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey } from '../auth/form-parts';

const NAME_MAX = 64;

type Failure = 'machines.errors.name' | 'machines.errors.notFound';

export function MachineList({ runners }: { runners: Runner[] }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Runner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | ErrorKey | undefined>();

  if (runners.length === 0) {
    return (
      <EmptyState
        title={t('machines.empty.title')}
        description={t('machines.empty.body')}
        action={
          <code className="rounded-control bg-hover px-3 py-2 text-sm">
            {t('machines.empty.command')}
          </code>
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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-ink-2">
            <tr>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('machines.columns.name')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('machines.columns.os')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('machines.columns.cliVersion')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('machines.columns.paired')}
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                {t('machines.columns.lastUsed')}
              </th>
              <th scope="col" className="py-2 font-normal">
                <span className="sr-only">{t('machines.columns.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runners.map((runner) => (
              <tr key={runner.id} className="border-t border-current/10">
                <td className="py-3 pr-4 align-top">
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
                    <span className="break-words">{runner.name}</span>
                  )}
                </td>
                <td className="py-3 pr-4 align-top break-words">{runner.os}</td>
                <td className="py-3 pr-4 align-top">{runner.cliVersion}</td>
                <td className="py-3 pr-4 align-top">
                  {formatDate(runner.createdAt)}
                </td>
                <td className="py-3 pr-4 align-top">
                  {runner.lastUsedAt
                    ? formatDate(runner.lastUsedAt)
                    : t('machines.neverUsed')}
                </td>
                <td className="py-3 align-top">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="glass"
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
