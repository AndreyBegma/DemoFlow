import type { ComponentType } from 'react';
import type { PlayerShape } from '@/lib/playback';
import { LunaVideoPlayer } from './luna-video-player';

/** What a page drives the playhead with, once the player can seek. */
export interface VideoPlayerControls {
  seek(ms: number): void;
  play(): void;
}

/** What a page needs from a player, whichever implementation plays. */
export interface VideoPlayerProps {
  src: string;
  /** The picture's aspect ratio: 16:9, 9:16 or 1:1. */
  shape: PlayerShape;
  /** Shown before playback starts. */
  poster?: string;
  /** The player could not load or play `src`. */
  onError(): void;
  /**
   * Called once the player can seek, and again when another implementation
   * takes over (the native fallback). The share page's chapters use it.
   */
  onControls?(controls: VideoPlayerControls): void;
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
