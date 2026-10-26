'use client';

import { useEffect, useRef } from 'react';
import { t } from '@/i18n';

/**
 * The demo video: muted, looping, with controls. It autoplays only when the
 * visitor has not asked for reduced motion; the poster is the first frame.
 */
export function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    // A browser may still refuse autoplay; the controls are there.
    video.play().catch(() => {});
  }, []);

  return (
    <video
      ref={ref}
      className="block aspect-video w-full rounded-control bg-black"
      src="/demo/landing.mp4"
      poster="/demo/landing-poster.png"
      aria-label={t('landing.video.label')}
      muted
      loop
      playsInline
      controls
      preload="metadata"
    />
  );
}
