import type { ComponentType } from 'react';
import { NativeVideoPlayer } from './native-video-player';

/** What the run page needs from a player, whichever implementation plays. */
export interface VideoPlayerProps {
  src: string;
  /** 9:16 instead of 16:9. */
  vertical: boolean;
  /** The player could not load or play `src`. */
  onError(): void;
}

export type VideoPlayer = ComponentType<VideoPlayerProps>;

/**
 * The player the run page uses. Always the native `<video>` for now.
 *
 * Trigger for a second implementation: a `luna-player` release that ships the
 * player component (ADR-0009 §2; 0.1.2 does not). Then this returns the Luna
 * player, with one rule: when Luna fails to load, fall back to the native one.
 */
export function choosePlayer(): VideoPlayer {
  return NativeVideoPlayer;
}
