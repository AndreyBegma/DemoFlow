'use client';

import type { VideoPlayerProps } from './video-player';

const BOX = {
  landscape: 'aspect-video',
  vertical: 'aspect-[9/16] max-w-sm',
  square: 'aspect-square max-w-md',
} as const;

/** The browser's own `<video>`; the `VideoPlayer` implementation in use. */
export function NativeVideoPlayer({ src, shape, onError }: VideoPlayerProps) {
  return (
    <video
      key={src}
      src={src}
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
