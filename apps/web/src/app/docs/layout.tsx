import { buttonClassName } from '@andrewbehma/glass-ui/button';
import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/i18n';
import { DocsSidebar } from './_components/docs-sidebar';
import { OnThisPage } from './_components/on-this-page';

export const metadata: Metadata = {
  title: {
    template: `%s · ${t('meta.title')}`,
    default: `${t('docs.meta.title')} · ${t('meta.title')}`,
  },
};

// No session is read here: every docs page is static (spec #179, Decision 5).
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-10 p-3">
        <div className="glass mx-auto flex max-w-6xl items-center justify-between rounded-surface px-4 py-2">
          <Link
            href="/"
            aria-label={t('docs.header.home')}
            className="text-lg font-semibold"
          >
            {t('meta.title')}
          </Link>
          <Link
            href="/app"
            className={buttonClassName({ variant: 'solid', size: 'sm' })}
          >
            {t('docs.header.openApp')}
          </Link>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_12rem]">
        <aside>
          <DocsSidebar />
        </aside>
        <article className="min-w-0 max-w-3xl">{children}</article>
        <aside className="hidden xl:block">
          <OnThisPage />
        </aside>
      </div>
    </>
  );
}
