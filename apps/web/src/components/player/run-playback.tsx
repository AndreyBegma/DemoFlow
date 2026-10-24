'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { deleteRunArtifacts, getRun, type RunDetail } from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import {
  availability,
  type DeleteFailureKey,
  deleteFailureKey,
  downloadUrl,
  isGifFormat,
  orderFormats,
  type PlayableFormat,
  playerShape,
  videoUrl,
} from '@/lib/playback';
import { choosePlayer } from './video-player';

/**
 * The format switcher, the player (or image), the availability messages and
 * the control that deletes the run's files from its machine.
 */
export function RunPlayback({
  runId,
  formats: runFormats,
  machine: initialMachine,
  artifactsDeletedAt: initialDeletedAt,
}: {
  runId: string;
  formats: string[];
  machine: RunDetail['machine'];
  artifactsDeletedAt: string | null;
}) {
  const router = useRouter();
  const formats = orderFormats(runFormats);
  const [format, setFormat] = useState<PlayableFormat | undefined>(formats[0]);
  const [machine, setMachine] = useState(initialMachine);
  const [deletedAt, setDeletedAt] = useState(initialDeletedAt);
  const [playerFailed, setPlayerFailed] = useState(false);
  // Bumped by Retry, so the player remounts and tries the stream again.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  // True while Download re-checks the run before the browser takes over.
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // True from the confirmation until the answer: the player is unmounted so
  // the browser drops its range request and the relay cancels the stream.
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<
    DeleteFailureKey | undefined
  >();

  if (deletedAt !== null) {
    return (
      <EmptyState
        title={t('runPage.deleted.title')}
        description={t('runPage.deleted.body', { date: formatDate(deletedAt) })}
      />
    );
  }

  if (format === undefined) {
    return <Banner tone="info">{t('runPage.noFormats')}</Banner>;
  }

  /** Asks the API again whether the machine is still there and online. */
  async function refetchMachine() {
    setBusy(true);
    const result = await getRun(runId);
    setBusy(false);
    if (result.ok) {
      setMachine(result.data.machine);
      // A 410 from another tab's deletion looks like any player error.
      setDeletedAt(result.data.run.artifactsDeletedAt);
    }
  }

  /**
   * Re-checks the run, then lets the browser stream the attachment to disk. A
   * navigation shows no HTTP status, so an offline machine or deleted files
   * must be caught here (spec #300, Decision 3).
   */
  async function download(target: PlayableFormat) {
    setChecking(true);
    const result = await getRun(runId);
    setChecking(false);
    if (!result.ok) return;
    setMachine(result.data.machine);
    setDeletedAt(result.data.run.artifactsDeletedAt);
    if (result.data.machine?.online !== true) return;
    if (result.data.run.artifactsDeletedAt !== null) return;
    const link = document.createElement('a');
    link.href = downloadUrl(runId, target);
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function confirmDelete() {
    setDeleteError(undefined);
    setDeleting(true);
    const result = await deleteRunArtifacts(runId);
    setConfirming(false);
    if (result.ok) {
      setDeletedAt(new Date().toISOString());
      router.refresh();
      return;
    }
    setDeleteError(deleteFailureKey(result.code));
    setDeleting(false);
    // The player comes back on the same attempt count, so it tries again.
    setAttempt((current) => current + 1);
  }

  async function handlePlayerError() {
    setPlayerFailed(true);
    await refetchMachine();
  }

  async function retry() {
    await refetchMachine();
    setPlayerFailed(false);
    setAttempt((current) => current + 1);
  }

  const state = deleting ? 'deleting' : availability(machine, playerFailed);
  const online = machine?.online === true;
  const Player = choosePlayer();
  const src = videoUrl(runId, format);
  const isGif = isGifFormat(format);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {formats.length > 1 ? (
          <SegmentedControl aria-label={t('runPage.formats.label')}>
            {formats.map((candidate) => (
              <SegmentedControlItem
                key={candidate}
                active={candidate === format}
                layoutId="run-format"
              >
                <button
                  type="button"
                  aria-pressed={candidate === format}
                  className="px-3 py-1 text-sm"
                  onClick={() => {
                    setFormat(candidate);
                    setPlayerFailed(false);
                  }}
                >
                  {t(`runPage.formats.${candidate}`)}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : null}
        <Button
          type="button"
          variant="glass"
          disabled={!online || deleting || checking}
          onClick={() => void download(format)}
        >
          {checking
            ? t('runPage.download.checking')
            : t('runPage.download.button')}
        </Button>
        {online ? null : (
          <span className="text-sm text-ink-2">
            {t('runPage.download.offlineHint')}
          </span>
        )}
      </div>
      {state === 'ready' && isGif ? (
        // biome-ignore lint/performance/noImgElement: a relay stream, not a static asset next/image can optimize
        <img
          key={`${src}-${attempt}`}
          src={src}
          alt={t('runPage.gifAlt')}
          onError={handlePlayerError}
          className="mx-auto max-h-[70vh] rounded-control"
        />
      ) : null}
      {state === 'ready' && !isGif ? (
        <Player
          key={`${src}-${attempt}`}
          src={src}
          shape={playerShape(format)}
          onError={handlePlayerError}
        />
      ) : null}
      {state === 'removed' ? (
        <Banner tone="warn">{t('runPage.removed')}</Banner>
      ) : null}
      {state === 'offline' && machine ? (
        <Banner tone="warn">
          {t('runPage.offline', { name: machine.name })}
        </Banner>
      ) : null}
      {state === 'failed' && machine ? (
        <Banner tone="danger">
          {t('runPage.failed', { name: machine.name })}
        </Banner>
      ) : null}
      {state === 'offline' || state === 'failed' ? (
        <div>
          <Button type="button" variant="glass" disabled={busy} onClick={retry}>
            {busy ? t('runPage.retrying') : t('runPage.retry')}
          </Button>
        </div>
      ) : null}
      {deleteError ? <Banner tone="danger">{t(deleteError)}</Banner> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="danger"
          disabled={!online || deleting}
          onClick={() => setConfirming(true)}
        >
          {t('runPage.delete.open')}
        </Button>
        {online ? null : (
          <span className="text-sm text-ink-2">
            {t('runPage.delete.offlineHint')}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('runPage.delete.title')}
        consequence={t('runPage.delete.consequence', {
          machine: machine?.name ?? '',
        })}
        verb={t('runPage.delete.confirm')}
        cancelLabel={t('runPage.delete.cancel')}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
