'use client';

import { Breadcrumb } from '@andrewbehma/glass-ui/breadcrumb';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Logomark } from '@/components/brand/logo';
import { t } from '@/i18n';
import type { Runner } from '@/lib/api';
import { type CrumbKind, crumbsFor } from '@/lib/crumbs';
import { activeNavId, NAV_ITEMS } from '@/lib/nav';
import { AccountMenu } from './account-menu';
import { useCrumbNames } from './crumb-names';
import { Sidebar } from './sidebar';

function crumbLabels(): Record<CrumbKind, string> {
  return {
    overview: t('app.shell.nav.overview'),
    projects: t('app.shell.nav.projects'),
    project: t('app.shell.crumbs.project'),
    run: t('app.shell.crumbs.run'),
    machines: t('app.shell.nav.machines'),
    shares: t('app.shell.nav.shares'),
    settings: t('app.shell.nav.settings'),
    device: t('app.shell.crumbs.device'),
  };
}

/**
 * The bar above every app page (spec #373, Decisions 2, 5, 6): the drawer
 * button on narrow screens, the breadcrumb, and the account menu.
 */
export function TopBar({
  email,
  runners,
}: {
  email: string;
  runners: Runner[] | null;
}) {
  const pathname = usePathname();
  const names = useCrumbNames();
  const crumbs = useMemo(
    () => crumbsFor(pathname, names, crumbLabels()),
    [pathname, names],
  );
  const [navOpen, setNavOpen] = useState(false);

  // Following a link in the drawer closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation
  useEffect(() => setNavOpen(false), [pathname]);

  // Widening to a desktop closes it too: the rail is on screen there.
  const breakpoint = useBreakpoint();
  useEffect(() => {
    if (breakpoint === 'desktop') setNavOpen(false);
  }, [breakpoint]);

  return (
    <header className="glass sticky top-2 z-chrome flex h-14 items-center gap-2 rounded-surface px-2 tablet:px-3">
      <SheetRoot open={navOpen} onOpenChange={setNavOpen}>
        <button
          type="button"
          aria-label={t('app.shell.openNav')}
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink desktop:hidden"
        >
          <Menu aria-hidden="true" className="size-5" />
        </button>
        <SheetContent title={t('app.shell.navSheet')} side="bottom">
          <div className="pb-4">
            <Sidebar
              activeId={activeNavId(pathname, NAV_ITEMS)}
              runners={runners}
              inSheet
            />
          </div>
        </SheetContent>
      </SheetRoot>
      <Link
        href="/app"
        aria-label={t('app.shell.home')}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-control desktop:hidden"
      >
        <Logomark size={22} />
      </Link>
      <Breadcrumb
        items={crumbs}
        aria-label={t('app.shell.crumbs.label')}
        overflowLabel={t('app.shell.crumbs.overflow')}
        className="min-w-0 flex-1 px-1"
        link={({ href, className, children, ...rest }) => (
          <Link href={href} className={className} {...rest}>
            {children}
          </Link>
        )}
      />
      <AccountMenu email={email} />
    </header>
  );
}
