// Labels without placeholders, so `t(label)` takes no params.
type DocsNavLabel =
  | 'docs.nav.start'
  | 'docs.nav.scenarios'
  | 'docs.nav.config'
  | 'docs.nav.cli'
  | 'docs.nav.record'
  | 'docs.nav.sdk'
  | 'docs.nav.runner'
  | 'docs.nav.mcp'
  | 'docs.nav.more';

export interface DocsNavEntry {
  /** The page's path: `/docs`, or `/docs/<folder>`. */
  href: string;
  label: DocsNavLabel;
}

/** The docs side navigation, in reading order (spec #179, Decision 1). */
export const DOCS_NAV: readonly DocsNavEntry[] = [
  { href: '/docs', label: 'docs.nav.start' },
  { href: '/docs/scenarios', label: 'docs.nav.scenarios' },
  { href: '/docs/config', label: 'docs.nav.config' },
  { href: '/docs/cli', label: 'docs.nav.cli' },
  { href: '/docs/record', label: 'docs.nav.record' },
  { href: '/docs/sdk', label: 'docs.nav.sdk' },
  { href: '/docs/runner', label: 'docs.nav.runner' },
  { href: '/docs/mcp', label: 'docs.nav.mcp' },
  { href: '/docs/more', label: 'docs.nav.more' },
];

/** The file under `src/app` that renders `href`. */
export function docsPageFile(href: string): string {
  return `${href.slice(1)}/page.mdx`;
}
