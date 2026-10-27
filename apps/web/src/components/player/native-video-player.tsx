'use client';

import { useCallback } from 'react';
import type { VideoPlayerProps } from './video-player';

const BOX = {
  landscape: 'aspect-video',
  vertical: 'aspect-[9/16] max-w-sm',
  square: 'aspect-square max-w-md',
} as const;

/** The browser's own `<video>`; the `VideoPlayer` implementation in use. */
export function NativeVideoPlayer({
  src,
  shape,
  poster,
  onError,
  onControls,
}: VideoPlayerProps) {
  const ref = useCallback(
    (video: HTMLVideoElement | null) => {
      if (video === null || onControls === undefined) return;
      onControls({
        seek: (ms) => {
          video.currentTime = ms / 1000;
        },
        // A play the browser refuses (autoplay policy) is no error.
        play: () => void video.play().catch(() => undefined),
      });
    },
    [onControls],
  );
  return (
    <video
      key={src}
      ref={ref}
      src={src}
      poster={poster}
      controls
      preload="metadata"
      playsInline
      onError={onError}
      className={`mx-auto max-h-[70vh] w-full rounded-control bg-black ${BOX[shape]}`}
    >
      <track kind="captions" />
    </video>
  );
}
