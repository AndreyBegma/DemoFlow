'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatLabel } from '@/components/projects/format-choice';
import { CellLabel, stacked } from '@/components/projects/stacked-rows';
import { t } from '@/i18n';
import { formatBytes } from '@/lib/format-bytes';
import { formatDate } from '@/lib/format-date';
import {
  daysLeft,
  type Share,
  type ShareErrorKey,
  type ShareStatus,
  type SharesList,
  shareErrorKey,
  shareFailureKey,
  shareRowActions,
} from '@/lib/shares';
import { extendShare, revokeShare } from '@/lib/shares-client';
import { CopyButton } from './copy-button';
import { QuotaMeter } from './quota-meter';

/** While a row uploads, the list asks the server again this often. */
const REFRESH_MS = 3000;

const PILL: Record<ShareStatus, 'running' | 'done' | 'error' | 'paused'> = {
  uploading: 'running',
  ready: 'done',
  failed: 'error',
  lost: 'paused',
};

function runHref(share: Share): string {
  return `/app/projects/${encodeURIComponent(share.projectId)}/runs/${encodeURIComponent(share.runId)}`;
}

/**
 * `/app/shares` (spec #350, Decision 3): the quota, then every share, newest
 * first, with Copy link, Open, Extend 30 days and Revoke per row. The table
 * sits on the readable content surface.
 */
export function ShareList({
  initial,
  now,
}: {
  initial: SharesList;
  /** The server's clock at render, so hydration counts the same days. */
  now: number;
}) {
  const router = useRouter();
  const [shares, setShares] = useState(initial.shares);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Share | null>(null);
  const [error, setError] = useState<ShareErrorKey | undefined>();

  // A refresh brings the server's list: it wins over the local edits.
  useEffect(() => setShares(initial.shares), [initial.shares]);

  const uploading = shares.some((share) => share.status === 'uploading');
  useEffect(() => {
    if (!uploading) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [uploading, router]);

  async function extend(share: Share) {
    setBusy(share.id);
    setError(undefined);
    const result = await extendShare(share.id);
    setBusy(null);
    if (result.ok) {
      setShares((rows) =>
        rows.map((row) => (row.id === share.id ? result.data : row)),
      );
    } else {
      setError(shareErrorKey(result.code));
    }
    router.refresh();
  }

  async function revoke(share: Share) {
    setBusy(share.id);
    setError(undefined);
    const result = await revokeShare(share.id);
    setBusy(null);
    setRevoking(null);
    // A 404 is a share already gone: the state the owner asked for.
    if (result.ok || result.status === 404) {
      setShares((rows) => rows.filter((row) => row.id !== share.id));
    } else {
      setError(shareErrorKey(result.code));
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Card variant="content" pad="md">
        <QuotaMeter quota={initial.quota} />
      </Card>
      {error ? <Banner tone="danger">{t(error)}</Banner> : null}
      {shares.length === 0 ? (
        <EmptyState
          title={t('shares.empty.title')}
          description={t('shares.empty.body')}
          action={
            <Link
              href="/app/projects"
              className={buttonClassName({ variant: 'glass' })}
            >
              {t('shares.empty.action')}
            </Link>
          }
        />
      ) : (
        <Card variant="content" pad="sm">
          <Table className={stacked.table}>
            <TableHead className={stacked.head}>
              <tr>
                <TableCell head scope="col">
                  {t('shares.columns.title')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.format')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.size')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.views')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.expires')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.password')}
                </TableCell>
                <TableCell head scope="col">
                  {t('shares.columns.status')}
                </TableCell>
                <TableCell head scope="col">
                  <span className="sr-only">{t('shares.columns.actions')}</span>
                </TableCell>
              </tr>
            </TableHead>
            <tbody className={stacked.body}>
              {shares.map((share) => {
                const actions = shareRowActions(share, now);
                const days = daysLeft(share.expiresAt, now);
                return (
                  <TableRow
                    key={share.id}
                    className={stacked.row}
                    data-share-id={share.id}
                  >
                    <TableCell className={stacked.lead}>
                      <Link
                        href={runHref(share)}
                        className="break-words font-medium text-ink hover:underline"
                      >
                        {share.title}
                      </Link>
                      {share.status === 'failed' ? (
                        <span className="block text-xs text-danger">
                          {t(shareFailureKey(share.failure))}
                        </span>
                      ) : null}
                      {share.status === 'lost' ? (
                        <span className="block text-xs text-danger">
                          {t('shares.lost')}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.format')}</CellLabel>
                      {formatLabel(share.format)}
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.size')}</CellLabel>
                      {formatBytes(share.sizeBytes)}
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.views')}</CellLabel>
                      {share.views}
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.expires')}</CellLabel>
                      <time
                        dateTime={share.expiresAt}
                        title={formatDate(share.expiresAt)}
                      >
                        {days > 0
                          ? t('shares.expiresIn', { days })
                          : t('shares.expiresToday')}
                      </time>
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.password')}</CellLabel>
                      {share.hasPassword ? t('shares.yes') : t('shares.no')}
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <CellLabel>{t('shares.columns.status')}</CellLabel>
                      <StatusPill
                        size="sm"
                        status={PILL[share.status]}
                        label={t(`shares.status.${share.status}`)}
                      />
                    </TableCell>
                    <TableCell className={stacked.cell}>
                      <div className="flex flex-wrap gap-2 md:justify-end">
                        {actions.copy ? (
                          <CopyButton
                            value={share.url}
                            label={`${t('shares.copy')} ${t('shares.dialog.link')}`}
                          />
                        ) : null}
                        {actions.open ? (
                          <a
                            href={share.url}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonClassName({
                              variant: 'ghost',
                              size: 'sm',
                            })}
                          >
                            {t('shares.open')}
                          </a>
                        ) : null}
                        {actions.extend ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy === share.id}
                            onClick={() => void extend(share)}
                          >
                            {busy === share.id
                              ? t('shares.extending')
                              : t('shares.extend')}
                          </Button>
                        ) : null}
                        {actions.retry ? (
                          <Link
                            href={runHref(share)}
                            className={buttonClassName({
                              variant: 'ghost',
                              size: 'sm',
                            })}
                          >
                            {t('shares.retry')}
                          </Link>
                        ) : null}
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={busy === share.id}
                          onClick={() => setRevoking(share)}
                        >
                          {t('shares.revoke')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('shares.revokeTitle', { title: revoking?.title ?? '' })}
        consequence={t('shares.revokeBody')}
        verb={t('shares.revoke')}
        cancelLabel={t('shares.revokeCancel')}
        busy={revoking !== null && busy === revoking.id}
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
      />
    </div>
  );
}
