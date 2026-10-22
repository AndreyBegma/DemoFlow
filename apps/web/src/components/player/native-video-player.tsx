'use client';

import type { VideoPlayerProps } from './video-player';

/** The browser's own `<video>`; the `VideoPlayer` implementation in use. */
export function NativeVideoPlayer({
  src,
  vertical,
  onError,
}: VideoPlayerProps) {
  return (
    <video
      key={src}
      src={src}
      controls
      preload="metadata"
      playsInline
      onError={onError}
      className={`mx-auto max-h-[70vh] w-full rounded-control bg-black ${
        vertical ? 'aspect-[9/16] max-w-sm' : 'aspect-video'
      }`}
    >
      <track kind="captions" />
    </video>
  );
}
