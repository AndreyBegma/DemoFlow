'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { StatusIndicator } from '@/components/status/status-indicator';
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
import { type StatusView, videoStatus } from '@/lib/status';
import { choosePlayer } from './video-player';

/**
 * Why the video cannot be shown, inside the black frame. The message sits on a
 * solid surface, so its text keeps the theme's contrast over the black.
 */
function FrameMessage({
  status,
  title,
  body,
  children,
}: {
  status: StatusView | null;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex aspect-video items-center justify-center p-4">
      <Card
        variant="content"
        pad="md"
        className="flex max-w-md flex-col items-center gap-2 text-center"
      >
        {status ? <StatusIndicator status={status} /> : null}
        <p className="font-medium">{title}</p>
        {body ? <p className="text-sm text-ink-2">{body}</p> : null}
        {children}
      </Card>
    </div>
  );
}

/**
 * The run page's body (spec #374, Decision 4): the player on a black frame,
 * and beside it the glass panel with the run's `details` and its actions —
 * `runAgain`, Download, the control that deletes the run's files from its
 * machine, and `deleteRun`. Below 1024px the panel stacks under the player.
 */
export function RunPlayback({
  runId,
  formats: runFormats,
  machine: initialMachine,
  artifactsDeletedAt: initialDeletedAt,
  details,
  runAgain,
  deleteRun,
}: {
  runId: string;
  formats: string[];
  machine: RunDetail['machine'];
  artifactsDeletedAt: string | null;
  details: ReactNode;
  runAgain: ReactNode;
  deleteRun: ReactNode;
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

  const online = machine?.online === true;
  const unavailable = videoStatus(
    { artifactsDeletedAt: deletedAt, formats: runFormats },
    machine,
  );
  // Download and Delete video files only make sense while there are files.
  const hasFiles = deletedAt === null && format !== undefined;

  function frame(): ReactNode {
    if (deletedAt !== null) {
      return (
        <FrameMessage
          status={unavailable}
          title={t('runPage.deleted.title')}
          body={t('runPage.deleted.body', { date: formatDate(deletedAt) })}
        />
      );
    }
    if (format === undefined) {
      return (
        <FrameMessage status={unavailable} title={t('runPage.noFormats')} />
      );
    }
    const state = deleting ? 'deleting' : availability(machine, playerFailed);
    const src = videoUrl(runId, format);
    if (state === 'ready' && isGifFormat(format)) {
      return (
        // biome-ignore lint/performance/noImgElement: a relay stream, not a static asset next/image can optimize
        <img
          key={`${src}-${attempt}`}
          src={src}
          alt={t('runPage.gifAlt')}
          onError={handlePlayerError}
          className="mx-auto max-h-[70vh]"
        />
      );
    }
    if (state === 'ready') {
      const Player = choosePlayer();
      return (
        <Player
          key={`${src}-${attempt}`}
          src={src}
          shape={playerShape(format)}
          onError={handlePlayerError}
        />
      );
    }
    if (state === 'deleting') return <div className="aspect-video" />;
    const retryButton = (
      <Button type="button" variant="glass" disabled={busy} onClick={retry}>
        {busy ? t('runPage.retrying') : t('runPage.retry')}
      </Button>
    );
    if (state === 'removed') {
      return <FrameMessage status={unavailable} title={t('runPage.removed')} />;
    }
    const name = machine?.name ?? '';
    return state === 'offline' ? (
      <FrameMessage status={unavailable} title={t('runPage.offline', { name })}>
        {retryButton}
      </FrameMessage>
    ) : (
      <FrameMessage status={null} title={t('runPage.failed', { name })}>
        {retryButton}
      </FrameMessage>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <div
          data-testid="run-player"
          className="overflow-hidden rounded-surface bg-black"
        >
          {frame()}
        </div>
        {format !== undefined && deletedAt === null && formats.length > 1 ? (
          <div className="max-w-full overflow-x-auto">
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
                    className="whitespace-nowrap px-3 py-1 text-sm"
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
          </div>
        ) : null}
      </div>
      <Card
        variant="glass"
        pad="md"
        role="complementary"
        aria-label={t('runPage.panel')}
        className="flex min-w-0 flex-col gap-4"
      >
        {details}
        <section
          aria-labelledby="run-actions"
          className="flex flex-col gap-3 border-t border-line pt-4"
        >
          <h2 id="run-actions" className="text-sm font-semibold">
            {t('runPage.actions')}
          </h2>
          {runAgain}
          {hasFiles && format !== undefined ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="solid"
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
          ) : null}
          {deleteError ? <Banner tone="danger">{t(deleteError)}</Banner> : null}
          {hasFiles ? (
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
          ) : null}
          {deleteRun}
        </section>
      </Card>
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
