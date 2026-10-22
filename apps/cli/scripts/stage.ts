// Stages the publishable `demoflow` package in dist/npm/ — the directory
// `npm pack` and `npm publish` run in (scripts/smoke.mjs, .woodpecker/release.yml).
//
//   node scripts/stage.ts
//
// dist/npm/
//   package.json      generated: no workspace references (manifest.ts)
//   dist/bin/main.js  src/main.ts with every @demoflow/* package bundled in
//   dist/playwright/  `demoflow/playwright` (ADR-0015): packages/playwright
//                     bundled, @playwright/test external, and its declarations
//   fonts/            the renderer's Inter files and their licence
//   README.md, LICENSE
//
// The bundle sits two directories deep on purpose: the renderer reads its fonts
// from `new URL('../../fonts/…', import.meta.url)`, written for its own
// src/ffmpeg/font.ts. Bundled, that URL is the bundle's, so `../../fonts` is
// the package root's fonts/. The build fails if that reference changes.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { build, type Plugin } from 'esbuild';
import {
  BIN,
  type Manifest,
  PLAYWRIGHT_ENTRY,
  PLAYWRIGHT_TYPES,
  publishManifest,
  WORKSPACE_SCOPE,
} from './manifest.ts';

const CLI = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(CLI, '../..');
const OUT = path.join(CLI, 'dist', 'npm');
const PLAYWRIGHT = path.join(ROOT, 'packages', 'playwright');
const PLAYWRIGHT_PEER = '@playwright/test';
const FONTS = path.join(ROOT, 'packages', 'renderer', 'fonts');
const FONT_REFERENCE = '../../fonts/';

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Manifest;
}

async function workspaceManifests(): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>();
  for (const entry of await readdir(path.join(ROOT, 'packages'))) {
    const manifest = await readManifest(path.join(ROOT, 'packages', entry));
    if (manifest.name !== undefined) manifests.set(manifest.name, manifest);
  }
  return manifests;
}

/** The package a bare import names: `a/b/c` → `a`, `@s/a/b` → `@s/a`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Bundles the workspace and leaves every published dependency external. An
 * import of anything else is an error, not a silent inline: it would be a
 * dependency the manifest does not declare.
 */
function externals(dependencies: Record<string, string>): Plugin {
  return {
    name: 'demoflow-externals',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // `D:\…` passes the filter on Windows: only bare imports are packages.
        if (args.kind === 'entry-point' || path.isAbsolute(args.path)) {
          return undefined;
        }
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        const name = packageName(args.path);
        if (name.startsWith(WORKSPACE_SCOPE)) return undefined;
        if (name in dependencies) return { path: args.path, external: true };
        return {
          errors: [
            {
              text: `${args.path} (imported by ${path.relative(ROOT, args.importer)}) is not a runtime dependency of the published package`,
            },
          ],
        };
      });
    },
  };
}

/** The module specifiers a declaration file imports or re-exports from. */
function declarationImports(text: string): string[] {
  const specifiers = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((match) => match[1] ?? '');
  return [...new Set(specifiers)];
}

const cli = await readManifest(CLI);
const manifest = publishManifest(cli, await workspaceManifests());
const dependencies = manifest.dependencies as Record<string, string>;
const peers = manifest.peerDependencies as Record<string, string>;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const bundle = path.join(OUT, BIN);
await build({
  entryPoints: [path.join(CLI, 'src', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [externals(dependencies)],
  logLevel: 'warning',
});

const bundleText = await readFile(bundle, 'utf8');
if (!bundleText.includes(FONT_REFERENCE)) {
  throw new Error(
    `the bundle no longer reads its fonts from ${FONT_REFERENCE}: update scripts/stage.ts to where the renderer looks now`,
  );
}
// The CLI never loads the fixture (spec 208, Decision 9).
if (bundleText.includes(PLAYWRIGHT_PEER)) {
  throw new Error(`${BIN} references ${PLAYWRIGHT_PEER}`);
}

// `demoflow/playwright`: the peer stays external, @demoflow/core is bundled in.
await build({
  entryPoints: [path.join(PLAYWRIGHT, 'src', 'index.ts')],
  outfile: path.join(OUT, PLAYWRIGHT_ENTRY),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [externals({ ...dependencies, ...peers })],
  logLevel: 'warning',
});
// Its public types come from tsc (packages/playwright's build) and may
// reference the peer only: anything else would not resolve once installed.
const declarations = (
  await readFile(path.join(PLAYWRIGHT, 'dist', 'index.d.ts'), 'utf8')
).replace(/^\/\/# sourceMappingURL=.*\n?/m, '');
const imported = declarationImports(declarations);
if (imported.some((specifier) => specifier !== PLAYWRIGHT_PEER)) {
  throw new Error(
    `packages/playwright/dist/index.d.ts imports ${imported.join(', ')}: its public types may reference ${PLAYWRIGHT_PEER} only`,
  );
}
await writeFile(path.join(OUT, PLAYWRIGHT_TYPES), declarations);
await cp(FONTS, path.join(OUT, 'fonts'), { recursive: true });
const fonts = await readdir(path.join(OUT, 'fonts'));
if (!fonts.includes('OFL.txt') || !fonts.some((f) => f.endsWith('.ttf'))) {
  throw new Error(`${FONTS} lacks its .ttf files or OFL.txt`);
}

await cp(path.join(CLI, 'README.md'), path.join(OUT, 'README.md'));
await cp(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
await writeFile(
  path.join(OUT, 'package.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `staged ${manifest.name}@${manifest.version} in ${path.relative(CLI, OUT)}`,
);
