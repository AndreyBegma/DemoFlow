import type { Metadata } from 'next';
import { SiteHeader } from '@/components/site-header';
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
// The article column is the plain page surface; only the navigation is glass
// (spec #376, Decision 3).
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader width="max-w-6xl" />
      <div className="mx-auto grid max-w-6xl gap-8 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_12rem]">
        <aside className="min-w-0">
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
