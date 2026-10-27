/** What a crumb stands for; the shell gives each kind its label. */
export type CrumbKind =
  | 'overview'
  | 'projects'
  | 'project'
  | 'run'
  | 'machines'
  | 'shares'
  | 'settings'
  | 'device';

export interface Crumb {
  id: string;
  label: string;
  /** Absent on the last crumb: the page itself is not a link. */
  href?: string;
}

/** A display name per path segment (a project or run id), from the pages. */
export type CrumbNames = ReadonlyMap<string, string>;

const SECTIONS: Readonly<Record<string, CrumbKind>> = {
  projects: 'projects',
  machines: 'machines',
  shares: 'shares',
  settings: 'settings',
  device: 'device',
};

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The trail for an `/app` pathname (spec #373, Decision 5). A project or run
 * segment shows its name from `names`, or its kind's label until the page
 * passes one — never the raw id. An unknown path falls back to Overview.
 */
export function crumbsFor(
  pathname: string,
  names: CrumbNames,
  labels: Readonly<Record<CrumbKind, string>>,
): Crumb[] {
  const parts = pathname
    .replace(/^\/app\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decode);
  const [section, id, sub, runId] = parts;
  const kind = section ? SECTIONS[section] : undefined;
  if (!kind) return [{ id: 'overview', label: labels.overview }];

  const crumbs: Crumb[] = [
    { id: kind, label: labels[kind], href: `/app/${section}` },
  ];
  if (kind === 'projects' && id) {
    crumbs.push({
      id: `project:${id}`,
      label: names.get(id) ?? labels.project,
      href: `/app/projects/${encodeURIComponent(id)}`,
    });
    if (sub === 'runs' && runId) {
      crumbs.push({
        id: `run:${runId}`,
        label: names.get(runId) ?? labels.run,
      });
    }
  }
  const last = crumbs.at(-1);
  if (last) delete last.href;
  return crumbs;
}
