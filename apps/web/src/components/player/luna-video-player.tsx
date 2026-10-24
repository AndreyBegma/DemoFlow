'use client';

import type { PlayerProps } from 'luna-player/player';
import type { ComponentType } from 'react';
import { lazy, Suspense, useState } from 'react';
import { t } from '@/i18n';
import type { PlayerShape } from '@/lib/playback';
import {
  afterPlayerError,
  loadVideoPlayer,
  lunaAspectRatio,
  type PlayerKind,
} from '@/lib/player-choice';
import { NativeVideoPlayer } from './native-video-player';
import type { VideoPlayer, VideoPlayerProps } from './video-player';

/**
 * The native player's box, as a width: Luna's frame is full-width with its own
 * aspect ratio, so the 70vh cap becomes the widest the picture may be.
 */
const BOX = {
  landscape: 'max-w-[calc(70vh*16/9)]',
  vertical: 'max-w-[min(24rem,calc(70vh*9/16))]',
  square: 'max-w-[min(28rem,70vh)]',
} as const;

const ASPECT = {
  landscape: 'aspect-video',
  vertical: 'aspect-[9/16]',
  square: 'aspect-square',
} as const;

function boxClass(shape: PlayerShape): string {
  return `mx-auto w-full overflow-hidden rounded-control bg-black ${BOX[shape]}`;
}

const labels: PlayerProps['labels'] = {
  ariaPlay: t('runPage.player.play'),
  ariaPause: t('runPage.player.pause'),
  ariaBack10: t('runPage.player.back10'),
  ariaForward10: t('runPage.player.forward10'),
  ariaMute: t('runPage.player.mute'),
  ariaUnmute: t('runPage.player.unmute'),
  ariaVolume: t('runPage.player.volume'),
  ariaSeek: t('runPage.player.seek'),
  seekPosition: (position, duration) =>
    t('runPage.player.seekPosition', { position, duration }),
  ariaPlaybackSpeed: (rate) => t('runPage.player.playbackSpeed', { rate }),
  ariaEnterFullscreen: t('runPage.player.enterFullscreen'),
  ariaExitFullscreen: t('runPage.player.exitFullscreen'),
  ariaClockElapsed: t('runPage.player.clockElapsed'),
  ariaClockRemaining: t('runPage.player.clockRemaining'),
  feedbackMuted: t('runPage.player.feedbackMuted'),
  feedbackRate: (rate) => t('runPage.player.feedbackRate', { rate }),
  feedbackSeconds: (seconds) =>
    t('runPage.player.feedbackSeconds', { seconds }),
  feedbackVolume: (percent) => t('runPage.player.feedbackVolume', { percent }),
  playbackFailed: t('runPage.player.playbackFailed'),
  playbackFailedHint: t('runPage.player.playbackFailedHint'),
  retryPlayback: t('runPage.player.retryPlayback'),
};

/** Luna's `<Player>` behind the `VideoPlayer` contract, in the native box. */
function adapt(Player: ComponentType<PlayerProps>): VideoPlayer {
  return function Luna({ src, shape, onError }: VideoPlayerProps) {
    return (
      <div className={boxClass(shape)}>
        <Player
          src={src}
          aspectRatio={lunaAspectRatio(shape)}
          labels={labels}
          storage={null}
          onError={() => onError()}
        />
      </div>
    );
  };
}

// A chunk that fails to load resolves to the native player, which then plays
// for the rest of the page session.
const LazyLuna = lazy(async () => ({
  default: await loadVideoPlayer<VideoPlayer>(
    () => import('luna-player/player').then(({ Player }) => adapt(Player)),
    NativeVideoPlayer,
  ),
}));

/**
 * The Luna Player (ADR-0009 §2), with the native `<video>` as its fallback:
 * when Luna's chunk does not load, or Luna gives up on `src`, the native one
 * plays the same stream; only its failure reaches the page's `onError`.
 */
export function LunaVideoPlayer({ src, shape, onError }: VideoPlayerProps) {
  const [current, setCurrent] = useState<PlayerKind>('luna');

  function handleError() {
    if (afterPlayerError(current) === 'native') setCurrent('native');
    else onError();
  }

  if (current === 'native') {
    return <NativeVideoPlayer src={src} shape={shape} onError={handleError} />;
  }
  return (
    <Suspense
      fallback={<div className={`${boxClass(shape)} ${ASPECT[shape]}`} />}
    >
      <LazyLuna src={src} shape={shape} onError={handleError} />
    </Suspense>
  );
}
