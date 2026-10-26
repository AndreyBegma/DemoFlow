'use client';

import { NavRail } from '@andrewbehma/glass-ui/nav-rail';
import {
  FolderKanban,
  LayoutDashboard,
  type LucideIcon,
  Server,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { t } from '@/i18n';
import type { Runner } from '@/lib/api';
import { NAV_ITEMS, type NavIcon } from '@/lib/nav';
import { MachineStatus } from './machine-status';

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  projects: FolderKanban,
  machines: Server,
  settings: Settings,
};

// Inside the drawer the sheet is the glass; the rail drops its own, so there
// is one blur per stack (vision §9).
const IN_SHEET =
  'h-auto! w-full! border-0! bg-transparent! bg-none! p-0! shadow-none! backdrop-blur-none!';

/**
 * The app's navigation (spec #373, Decisions 1–4): the brand, the nav items
 * with the active one marked, and the machine status pinned at the bottom.
 * A fixed glass rail on a desktop; the same content inside the drawer.
 */
export function Sidebar({
  activeId,
  runners,
  inSheet = false,
}: {
  activeId: string | null;
  runners: Runner[] | null;
  inSheet?: boolean;
}) {
  return (
    <NavRail
      aria-label={t('app.shell.navLabel')}
      // The drawer and the rail are never on screen together, but both stay
      // mounted on a resize; separate ids keep their capsules apart.
      layoutId={inSheet ? 'sheet-nav' : 'rail-nav'}
      className={inSheet ? IN_SHEET : 'h-full'}
      head={
        inSheet ? undefined : (
          // As tall as the top bar's row (rail p-2 + h-10 = top bar h-14).
          <Link
            href="/app"
            aria-label={t('app.shell.home')}
            className="flex h-10 items-center rounded-control px-3"
          >
            <Logo size={22} />
          </Link>
        )
      }
      groups={[
        {
          id: 'workspace',
          title: t('app.shell.navGroup'),
          items: NAV_ITEMS.map((item) => ({
            id: item.id,
            label: t(item.label),
            icon: ICONS[item.icon],
            href: item.href,
            active: item.id === activeId,
          })),
        },
      ]}
      footer={<MachineStatus runners={runners} />}
      link={({ href, className, children, ...rest }) => (
        <Link href={href} className={className} {...rest}>
          {children}
        </Link>
      )}
    />
  );
}
