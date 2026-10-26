'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { t } from '@/i18n';

interface Heading {
  id: string;
  text: string;
}

/** The `h2` headings of the page, collected once it has rendered. */
export function OnThisPage() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the trigger, the DOM is the source.
  useEffect(() => {
    const found =
      document.querySelectorAll<HTMLHeadingElement>('article h2[id]');
    setHeadings(
      Array.from(found, (heading) => ({
        id: heading.id,
        text: heading.textContent ?? '',
      })),
    );
  }, [pathname]);

  if (headings.length === 0) return null;
  return (
    <nav
      aria-label={t('docs.toc.label')}
      className="glass rounded-surface p-4 text-sm lg:sticky lg:top-24"
    >
      <p className="pb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
        {t('docs.toc.label')}
      </p>
      <ul className="flex flex-col gap-1.5 border-l border-line pl-3">
        {headings.map(({ id, text }) => (
          <li key={id}>
            <a href={`#${id}`} className="text-ink-2 hover:text-ink">
              {text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
