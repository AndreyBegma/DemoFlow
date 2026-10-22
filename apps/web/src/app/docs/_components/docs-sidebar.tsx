'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t } from '@/i18n';
import { DOCS_NAV } from '@/lib/docs-nav';

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('docs.nav.label')}
      className="glass rounded-surface p-3 lg:sticky lg:top-24"
    >
      <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        {t('docs.nav.title')}
      </p>
      <ul className="flex flex-wrap gap-1 lg:flex-col">
        {DOCS_NAV.map(({ href, label }) => {
          const current = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={`block rounded-control px-3 py-1.5 text-sm ${
                  current
                    ? 'bg-accent-soft font-semibold text-ink'
                    : 'text-ink-2 hover:bg-hover hover:text-ink'
                }`}
              >
                {t(label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
