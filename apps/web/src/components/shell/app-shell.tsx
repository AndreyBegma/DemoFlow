'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ResendButton } from '@/components/auth/resend-button';
import { t } from '@/i18n';
import type { Runner } from '@/lib/api';
import { activeNavId, NAV_ITEMS } from '@/lib/nav';
import { CrumbNamesProvider } from './crumb-names';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/**
 * The frame around every `/app` page (spec #373, Decisions 1–3): the canvas,
 * a fixed glass rail on a desktop, the top bar, the verify-email banner and
 * one readable content column. Pages render their content only.
 */
export function AppShell({
  email,
  emailVerified,
  runners,
  children,
}: {
  email: string;
  emailVerified: boolean;
  runners: Runner[] | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <CrumbNamesProvider>
      <a
        href="#main-content"
        className="sr-only z-top rounded-control bg-paper px-3 py-2 text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('app.shell.skip')}
      </a>
      <div className="canvas" aria-hidden="true" />
      <div className="flex min-h-dvh gap-2 p-2">
        <aside className="sticky top-2 hidden h-[calc(100dvh-1rem)] shrink-0 desktop:block">
          <Sidebar
            activeId={activeNavId(pathname, NAV_ITEMS)}
            runners={runners}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <TopBar email={email} runners={runners} />
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-2 py-4 outline-none tablet:px-4 tablet:py-6"
          >
            {emailVerified ? null : (
              <Banner tone="warn" title={t('app.shell.verifyTitle')}>
                <p className="break-words">
                  {t('app.shell.verifyBody', { email })}
                </p>
                <div className="mt-3">
                  <ResendButton
                    label={t('app.shell.resend')}
                    sentLabel={t('app.shell.resent')}
                  />
                </div>
              </Banner>
            )}
            {children}
          </main>
        </div>
      </div>
    </CrumbNamesProvider>
  );
}
