'use client';

import { t } from '@/i18n';
import { chapterTime, type ShareChapter } from '@/lib/share-page';

/**
 * The scenario's scenes as `mm:ss title` buttons; a click seeks the video to
 * the scene and plays (spec #351, Decision 3). No chapters, no list.
 */
export function Chapters({
  chapters,
  onSeek,
}: {
  chapters: ShareChapter[];
  onSeek(ms: number): void;
}) {
  if (chapters.length === 0) return null;
  return (
    <nav aria-labelledby="share-chapters">
      <h2 id="share-chapters" className="text-sm font-semibold text-ink-2">
        {t('sharePage.chapters.title')}
      </h2>
      <ol className="mt-2 flex flex-col">
        {chapters.map((chapter) => {
          const time = chapterTime(chapter.atMs);
          return (
            <li key={`${chapter.atMs}-${chapter.title}`}>
              <button
                type="button"
                aria-label={t('sharePage.chapters.seek', {
                  time,
                  title: chapter.title,
                })}
                onClick={() => onSeek(chapter.atMs)}
                className="flex w-full items-baseline gap-3 rounded-control px-2 py-1.5 text-left text-sm hover:bg-hover"
              >
                <span className="shrink-0 font-mono tabular-nums text-ink-2">
                  {time}
                </span>
                <span className="break-words">{chapter.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
