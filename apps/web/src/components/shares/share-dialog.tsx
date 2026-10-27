'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatLabel } from '@/components/projects/format-choice';
import { t } from '@/i18n';
import type { RunRender } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import { formatDuration } from '@/lib/format-duration';
import {
  DEFAULT_SHARE_LIFETIME,
  daysLeft,
  defaultShareFormat,
  isGifShare,
  markdownSnippet,
  quotaPreview,
  SHARE_LIFETIMES,
  SHARE_POLL_MS,
  type Share,
  type ShareErrorKey,
  type ShareLifetime,
  type SharesList,
  shareErrorKey,
  shareFailureKey,
  shareFor,
  shareFormatOptions,
  sharePasswordError,
} from '@/lib/shares';
import { createShare, getShare, listShares } from '@/lib/shares-client';
import { CopyButton } from './copy-button';
import { QuotaMeter } from './quota-meter';

/** A read-only field with its Copy button. */
function CopyField({
  label,
  copyLabel,
  value,
}: {
  label: string;
  copyLabel: string;
  value: string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(event) => event.currentTarget.select()}
        />
        <CopyButton value={value} label={copyLabel} size="md" />
      </div>
    </Field>
  );
}

/**
 * The Share dialog of the run page (spec #350, Decision 2): format, expiry,
 * an optional password and the quota; then the upload's progress, polled
 * every second, and the link. A run already shared in the chosen format shows
 * that share instead of a second Create. Glass is the dialog's chrome only;
 * its body sits on the readable content surface.
 */
export function ShareDialog({
  open,
  onOpenChange,
  runId,
  formats,
  renders,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  /** The run's formats, in display order. */
  formats: readonly string[];
  renders: readonly RunRender[] | null;
}) {
  const [list, setList] = useState<SharesList | 'error' | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [days, setDays] = useState<ShareLifetime>(DEFAULT_SHARE_LIFETIME);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState<Share | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ShareErrorKey | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const formatId = useId();
  const daysId = useId();
  const passwordId = useId();
  // Read on open only: a refresh of the page must not reset an open dialog.
  const run = useRef({ formats, renders });
  run.current = { formats, renders };

  const reload = useCallback(async (): Promise<SharesList | null> => {
    const result = await listShares();
    if (!result.ok) {
      setList('error');
      return null;
    }
    setList(result.data);
    return result.data;
  }, []);

  // Every open starts from the server's answer: shares change elsewhere.
  useEffect(() => {
    if (!open) return;
    setList(null);
    setError(undefined);
    setPassword('');
    setDays(DEFAULT_SHARE_LIFETIME);
    void reload().then((fresh) => {
      if (!fresh) return;
      const chosen = defaultShareFormat(
        shareFormatOptions(
          run.current.formats,
          run.current.renders,
          fresh.quota.maxFileBytes,
        ),
      );
      setFormat(chosen);
      setCurrent(
        chosen === null ? null : shareFor(fresh.shares, runId, chosen),
      );
    });
  }, [open, reload, runId]);

  const uploadingId = current?.status === 'uploading' ? current.id : null;

  // No fake percentage: ask again every second while the upload runs.
  useEffect(() => {
    if (!open || uploadingId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await getShare(uploadingId);
      if (cancelled) return;
      setNow(Date.now());
      if (result.ok) {
        setCurrent(result.data);
        if (result.data.status !== 'uploading') {
          void reload();
          return;
        }
      } else if (result.status === 404) {
        setCurrent(null);
        void reload();
        return;
      }
      // A failed poll is tried again on the next tick.
      timer = setTimeout(poll, SHARE_POLL_MS);
    };
    timer = setTimeout(poll, SHARE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, uploadingId, reload]);

  const loaded = list !== null && list !== 'error' ? list : null;
  const options = loaded
    ? shareFormatOptions(formats, renders, loaded.quota.maxFileBytes)
    : [];
  const option = options.find((candidate) => candidate.format === format);
  const passwordError = sharePasswordError(password);
  const fits = loaded
    ? quotaPreview(loaded.quota, option?.sizeBytes ?? null).fits
    : false;
  const canCreate =
    option !== undefined &&
    !option.tooLarge &&
    fits &&
    passwordError === null &&
    !creating;

  function chooseFormat(next: string) {
    setFormat(next);
    setError(undefined);
    setCurrent(loaded ? shareFor(loaded.shares, runId, next) : null);
  }

  async function create() {
    if (!canCreate || format === null) return;
    setCreating(true);
    setError(undefined);
    const result = await createShare({
      runId,
      format,
      expiresInDays: days,
      ...(password === '' ? {} : { password }),
    });
    setCreating(false);
    if (result.ok) {
      setPassword('');
      setNow(Date.now());
      setCurrent(result.data);
      return;
    }
    if (result.code === 'share-exists') {
      // Created in another tab meanwhile: show that one.
      const fresh = await reload();
      setCurrent(fresh ? shareFor(fresh.shares, runId, format) : null);
      return;
    }
    setError(shareErrorKey(result.code));
    if (result.code === 'quota-exceeded') void reload();
  }

  function body() {
    if (list === 'error') {
      return <Banner tone="danger">{t('shares.loadFailed')}</Banner>;
    }
    if (loaded === null) {
      return (
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner size="sm" label={null} />
          {t('shares.dialog.loading')}
        </div>
      );
    }
    if (current?.status === 'uploading') {
      const elapsed = Math.max(0, now - Date.parse(current.createdAt));
      return (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <Spinner size="lg" label={t('shares.dialog.uploading')} />
          <p className="font-medium">{t('shares.dialog.uploading')}</p>
          <p className="text-sm text-ink-2">
            {t('shares.dialog.uploadingDetail', {
              size:
                current.sizeBytes > 0
                  ? formatBytes(current.sizeBytes)
                  : t('shares.dialog.unknownSize'),
              elapsed: formatDuration(Math.round(elapsed / 1000) * 1000),
            })}
          </p>
        </div>
      );
    }
    if (current?.status === 'ready') {
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            <span className="font-medium">{t('shares.dialog.ready')}</span>{' '}
            {t('shares.dialog.expiresIn', {
              days: daysLeft(current.expiresAt, Date.now()),
            })}
          </p>
          <CopyField
            label={t('shares.dialog.link')}
            copyLabel={`${t('shares.copy')} ${t('shares.dialog.link')}`}
            value={current.url}
          />
          {current.fileUrl ? (
            <>
              <CopyField
                label={t('shares.dialog.fileLink')}
                copyLabel={`${t('shares.copy')} ${t('shares.dialog.fileLink')}`}
                value={current.fileUrl}
              />
              {isGifShare(current.format) ? (
                <CopyField
                  label={t('shares.dialog.markdown')}
                  copyLabel={`${t('shares.copy')} ${t('shares.dialog.markdown')}`}
                  value={markdownSnippet(current.title, current.fileUrl)}
                />
              ) : null}
            </>
          ) : (
            <p className="text-sm text-ink-2">{t('shares.dialog.protected')}</p>
          )}
        </div>
      );
    }
    if (current?.status === 'failed' || current?.status === 'lost') {
      return (
        <Banner tone="danger">
          <span className="font-medium">{t('shares.failure.title')}</span>{' '}
          {current.status === 'lost'
            ? t('shares.lost')
            : t(shareFailureKey(current.failure))}
        </Banner>
      );
    }
    return (
      <form
        id="share-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {error ? <Banner tone="danger">{t(error)}</Banner> : null}
        <Field label={t('shares.dialog.format')} htmlFor={formatId}>
          <Select
            id={formatId}
            value={format ?? ''}
            onChange={(event) => chooseFormat(event.target.value)}
          >
            {options.map((candidate) => (
              <option
                key={candidate.format}
                value={candidate.format}
                disabled={candidate.tooLarge}
              >
                {candidate.tooLarge
                  ? t('shares.dialog.overLimit', {
                      format: formatLabel(candidate.format),
                      limit: formatBytes(loaded.quota.maxFileBytes),
                    })
                  : candidate.sizeBytes === null
                    ? formatLabel(candidate.format)
                    : t('shares.dialog.formatSize', {
                        format: formatLabel(candidate.format),
                        size: formatBytes(candidate.sizeBytes),
                      })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('shares.dialog.expires')} htmlFor={daysId}>
          <Select
            id={daysId}
            value={String(days)}
            onChange={(event) => {
              const next = SHARE_LIFETIMES.find(
                (lifetime) => String(lifetime) === event.target.value,
              );
              if (next) setDays(next);
            }}
          >
            {SHARE_LIFETIMES.map((lifetime) => (
              <option key={lifetime} value={lifetime}>
                {t('shares.dialog.days', { days: lifetime })}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('shares.dialog.password.label')}
          htmlFor={passwordId}
          hint={t('shares.dialog.password.hint')}
          error={passwordError ? t(passwordError) : undefined}
        >
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <QuotaMeter quota={loaded.quota} addBytes={option?.sizeBytes ?? 0} />
      </form>
    );
  }

  function footer() {
    const close = (
      <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
        {t('shares.dialog.close')}
      </Button>
    );
    if (loaded === null) return close;
    if (current?.status === 'uploading') return close;
    if (current?.status === 'ready') {
      return (
        <>
          <Link
            href="/app/shares"
            className={buttonClassName({ variant: 'ghost' })}
          >
            {t('shares.dialog.manage')}
          </Link>
          {close}
        </>
      );
    }
    if (current?.status === 'failed' || current?.status === 'lost') {
      return (
        <>
          {close}
          <Button
            type="button"
            variant="solid"
            onClick={() => {
              // Create replaces a failed or lost share (spec #347).
              setCurrent(null);
              setError(undefined);
            }}
          >
            {t('shares.dialog.tryAgain')}
          </Button>
        </>
      );
    }
    return (
      <>
        {close}
        <Button
          type="submit"
          form="share-form"
          variant="solid"
          disabled={!canCreate}
        >
          {creating ? t('shares.dialog.creating') : t('shares.dialog.create')}
        </Button>
      </>
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('shares.dialog.title')}
        description={t('shares.dialog.notice')}
        footer={footer()}
      >
        <Card variant="content" pad="md">
          {body()}
        </Card>
      </DialogContent>
    </DialogRoot>
  );
}
