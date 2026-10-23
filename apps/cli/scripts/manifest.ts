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
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export const WORKSPACE_SCOPE = '@demoflow/';

/** The bundle, relative to the package root: two levels deep (see stage.ts). */
export const BIN = 'dist/bin/main.js';

/**
 * `demoflow/playwright`, the Playwright Test fixture (ADR-0015): its bundle
 * and its declarations, relative to the package root.
 */
export const PLAYWRIGHT_ENTRY = 'dist/playwright/index.js';
export const PLAYWRIGHT_TYPES = 'dist/playwright/index.d.ts';

/**
 * The name the package is published under. The workspace package is
 * `@demoflow/cli`: were it also `demoflow`, `npx demoflow` inside the
 * repository would resolve to the private workspace package (#105).
 */
export const PUBLISHED_NAME = 'demoflow';

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
  visit(cli, cli.name ?? PUBLISHED_NAME);

  return Object.fromEntries(
    [...found.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, { version }]) => [name, version]),
  );
}

/**
 * The CLI's peer dependencies, each optional: `demoflow` installed alone must
 * work, and only `demoflow/playwright` needs its peer (ADR-0015 §2). The peer
 * range is a range by nature; `dependencies` stay exact.
 */
export function peerDependencies(cli: Manifest): {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: true }>;
} {
  const peers = cli.peerDependencies ?? {};
  for (const name of Object.keys(peers)) {
    if (cli.peerDependenciesMeta?.[name]?.optional !== true) {
      throw new Error(
        `${name} is a peer dependency: mark it optional in peerDependenciesMeta`,
      );
    }
  }
  return {
    peerDependencies: { ...peers },
    peerDependenciesMeta: Object.fromEntries(
      Object.keys(peers).map((name) => [name, { optional: true as const }]),
    ),
  };
}

/** The manifest `npm pack` and `npm publish` see: no workspace references, no scripts. */
export function publishManifest(
  cli: Manifest,
  workspace: ReadonlyMap<string, Manifest>,
): Record<string, unknown> {
  if (cli.name === undefined || cli.version === undefined) {
    throw new Error('the CLI manifest has no name or version');
  }
  const dependencies = runtimeDependencies(cli, workspace);
  const peers = peerDependencies(cli);
  for (const name of Object.keys(peers.peerDependencies)) {
    if (name in dependencies) {
      throw new Error(`${name} is a peer dependency and a runtime dependency`);
    }
  }
  return {
    name: PUBLISHED_NAME,
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
    // Only `demoflow/playwright` is importable; the bin is not an export.
    exports: {
      './playwright': {
        types: `./${PLAYWRIGHT_TYPES}`,
        import: `./${PLAYWRIGHT_ENTRY}`,
      },
      './package.json': './package.json',
    },
    files: ['dist', 'fonts'],
    engines: cli.engines,
    dependencies,
    ...peers,
  };
}
