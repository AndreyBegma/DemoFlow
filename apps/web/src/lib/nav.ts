// Labels without placeholders, so `t(label)` takes no params.
type NavLabel =
  | 'app.shell.nav.overview'
  | 'app.shell.nav.projects'
  | 'app.shell.nav.machines'
  | 'app.shell.nav.shares'
  | 'app.shell.nav.settings';

/** Names an icon the sidebar draws; kept out of this module so it stays pure. */
export type NavIcon =
  | 'overview'
  | 'projects'
  | 'machines'
  | 'shares'
  | 'settings';

export interface NavItem {
  id: string;
  href: string;
  label: NavLabel;
  icon: NavIcon;
}

/**
 * The app's sidebar, in order (spec #373, Decision 2). A later page adds its
 * entry here with one line.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'overview',
    href: '/app',
    label: 'app.shell.nav.overview',
    icon: 'overview',
  },
  {
    id: 'projects',
    href: '/app/projects',
    label: 'app.shell.nav.projects',
    icon: 'projects',
  },
  {
    id: 'machines',
    href: '/app/machines',
    label: 'app.shell.nav.machines',
    icon: 'machines',
  },
  {
    id: 'shares',
    href: '/app/shares',
    label: 'app.shell.nav.shares',
    icon: 'shares',
  },
  {
    id: 'settings',
    href: '/app/settings',
    label: 'app.shell.nav.settings',
    icon: 'settings',
  },
];

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The item whose `href` is the longest prefix of `pathname`, so a run page
 * lights Projects; null when no item matches.
 */
export function activeNavId(
  pathname: string,
  items: readonly NavItem[] = NAV_ITEMS,
): string | null {
  let best: NavItem | null = null;
  for (const item of items) {
    if (!matches(pathname, item.href)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best?.id ?? null;
}
