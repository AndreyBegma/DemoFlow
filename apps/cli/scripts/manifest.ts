/**
 * The published `package.json` of `demoflow`, generated from the workspace
 * manifests (spec #75, Decision 5): the `@demoflow/*` packages are bundled, so
 * they disappear; their third-party `dependencies` become the package's own.
 */

export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  license?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
}

export const WORKSPACE_SCOPE = '@demoflow/';

/** The bundle, relative to the package root: two levels deep (see stage.ts). */
export const BIN = 'dist/bin/main.js';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The third-party runtime dependencies of `cli` and of every workspace package
 * it reaches, sorted. Each must be pinned exactly, and two packages naming the
 * same dependency must agree on its version.
 */
export function runtimeDependencies(
  cli: Manifest,
  workspace: ReadonlyMap<string, Manifest>,
): Record<string, string> {
  const found = new Map<string, { version: string; from: string }>();
  const visited = new Set<string>();

  const visit = (manifest: Manifest, from: string): void => {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith(WORKSPACE_SCOPE)) {
        if (visited.has(name)) continue;
        visited.add(name);
        const inner = workspace.get(name);
        if (inner === undefined) {
          throw new Error(`${from} depends on ${name}, not in the workspace`);
        }
        visit(inner, name);
        continue;
      }
      if (!EXACT_VERSION.test(version)) {
        throw new Error(
          `${from} depends on ${name}@${version}: pin it to an exact version`,
        );
      }
      const seen = found.get(name);
      if (seen !== undefined && seen.version !== version) {
        throw new Error(
          `${name}: ${seen.from} pins ${seen.version}, ${from} pins ${version}`,
        );
      }
      found.set(name, { version, from });
    }
  };
  visit(cli, cli.name ?? 'demoflow');

  return Object.fromEntries(
    [...found.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, { version }]) => [name, version]),
  );
}

/** The manifest `npm pack` and `npm publish` see: no workspace references, no scripts. */
export function publishManifest(
  cli: Manifest,
  workspace: ReadonlyMap<string, Manifest>,
): Record<string, unknown> {
  if (cli.name === undefined || cli.version === undefined) {
    throw new Error('the CLI manifest has no name or version');
  }
  return {
    name: cli.name,
    version: cli.version,
    description: cli.description,
    keywords: cli.keywords,
    homepage: 'https://github.com/AndreyBegma/DemoFlow#readme',
    bugs: 'https://github.com/AndreyBegma/DemoFlow/issues',
    repository: {
      type: 'git',
      url: 'git+https://github.com/AndreyBegma/DemoFlow.git',
      directory: 'apps/cli',
    },
    license: cli.license,
    type: 'module',
    bin: { demoflow: BIN },
    files: ['dist', 'fonts'],
    engines: cli.engines,
    dependencies: runtimeDependencies(cli, workspace),
  };
}
