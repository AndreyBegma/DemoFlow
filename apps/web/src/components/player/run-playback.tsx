'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useState } from 'react';
import { t } from '@/i18n';
import { getRun, type RunDetail } from '@/lib/api';
import {
  availability,
  orderFormats,
  type PlayableFormat,
  videoUrl,
} from '@/lib/playback';
import { choosePlayer } from './video-player';

/** The format switcher, the player (or image) and the availability messages. */
export function RunPlayback({
  runId,
  formats: runFormats,
  machine: initialMachine,
}: {
  runId: string;
  formats: string[];
  machine: RunDetail['machine'];
}) {
  const formats = orderFormats(runFormats);
  const [format, setFormat] = useState<PlayableFormat | undefined>(formats[0]);
  const [machine, setMachine] = useState(initialMachine);
  const [playerFailed, setPlayerFailed] = useState(false);
  // Bumped by Retry, so the player remounts and tries the stream again.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  if (format === undefined) {
    return <Banner tone="info">{t('runPage.noFormats')}</Banner>;
  }

  /** Asks the API again whether the machine is still there and online. */
  async function refetchMachine() {
    setBusy(true);
    const result = await getRun(runId);
    setBusy(false);
    if (result.ok) setMachine(result.data.machine);
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

  const state = availability(machine, playerFailed);
  const Player = choosePlayer();
  const src = videoUrl(runId, format);

  return (
    <div className="flex flex-col gap-4">
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
      {state === 'ready' && format === 'gif' ? (
        // biome-ignore lint/performance/noImgElement: a relay stream, not a static asset next/image can optimize
        <img
          key={`${src}-${attempt}`}
          src={src}
          alt={t('runPage.gifAlt')}
          onError={handlePlayerError}
          className="mx-auto max-h-[70vh] rounded-control"
        />
      ) : null}
      {state === 'ready' && format !== 'gif' ? (
        <Player
          key={`${src}-${attempt}`}
          src={src}
          vertical={format === 'mp4-vertical'}
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
    </div>
  );
}
