import type { ComponentType } from 'react';
import type { PlayerShape } from '@/lib/playback';
import { LunaVideoPlayer } from './luna-video-player';

/** What the run page needs from a player, whichever implementation plays. */
export interface VideoPlayerProps {
  src: string;
  /** The picture's aspect ratio: 16:9, 9:16 or 1:1. */
  shape: PlayerShape;
  /** The player could not load or play `src`. */
  onError(): void;
}

export type VideoPlayer = ComponentType<VideoPlayerProps>;

/**
 * The player the run page uses: the Luna Player (ADR-0009 §2, `luna-player`
 * 0.2.0), which falls back to the native `<video>` when its chunk fails to
 * load or it gives up on the stream.
 */
export function choosePlayer(): VideoPlayer {
  return LunaVideoPlayer;
}
