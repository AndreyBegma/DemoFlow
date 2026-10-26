'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { useCallback, useRef, useState } from 'react';
import {
  choosePlayer,
  type VideoPlayerControls,
} from '@/components/player/video-player';
import { t } from '@/i18n';
import { type ShareData, samePath, shareShape } from '@/lib/share-page';
import { Chapters } from './chapters';
import { MadeWithBadge } from './made-with-badge';

/**
 * An open share (spec #351, Decision 2): the title and description, the video
 * (or the GIF), its chapters, Download and the badge.
 */
export function ShareView({ share }: { share: ShareData }) {
  const controls = useRef<VideoPlayerControls | null>(null);
  // A chapter clicked before the player loaded plays once it can seek.
  const pending = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);
  const Player = choosePlayer();
  const src = samePath(share.fileUrl);

  const handleControls = useCallback((next: VideoPlayerControls) => {
    controls.current = next;
    if (pending.current !== null) {
      next.seek(pending.current);
      next.play();
      pending.current = null;
    }
  }, []);

  function seek(ms: number) {
    if (controls.current === null) {
      pending.current = ms;
      return;
    }
    controls.current.seek(ms);
    controls.current.play();
  }

  const video = share.kind === 'video';

  return (
    <Card pad="lg" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="break-words text-2xl font-semibold">{share.title}</h1>
        {share.description ? (
          <p className="whitespace-pre-line break-words text-ink-2">
            {share.description}
          </p>
        ) : null}
      </header>
      {video ? (
        <Player
          src={src}
          shape={shareShape(share.width, share.height)}
          poster={samePath(share.posterUrl)}
          onError={() => setFailed(true)}
          onControls={handleControls}
        />
      ) : (
        // biome-ignore lint/performance/noImgElement: a streamed share file, not a static asset next/image can optimize
        <img
          src={src}
          alt={share.title}
          className="mx-auto max-h-[70vh] rounded-control"
        />
      )}
      {failed ? (
        <Banner tone="danger">{t('sharePage.playbackFailed')}</Banner>
      ) : null}
      {video ? <Chapters chapters={share.chapters} onSeek={seek} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a
          href={samePath(share.downloadUrl)}
          download
          className={buttonClassName({ variant: 'solid' })}
        >
          {t('sharePage.download')}
        </a>
        <MadeWithBadge />
      </div>
    </Card>
  );
}
