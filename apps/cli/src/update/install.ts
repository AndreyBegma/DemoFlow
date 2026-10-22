import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostEnvironment } from '../config/platform.ts';

export type Manager = 'npm' | 'bun' | 'pnpm' | 'yarn';

/** The running package: its directory and the name in its manifest. */
export interface PackageLocation {
  dir: string;
  name: string;
}

/**
 * How this `demoflow` was installed (spec 166, Decision 5):
 * - `ephemeral`: an npx / bunx / pnpm dlx cache, which already runs the latest;
 * - `source`: the workspace checkout, which is not an install at all;
 * - `global`: a global install by `manager`;
 * - `local`: a project's `node_modules`;
 * - `unknown`: anything else.
 */
export type Install =
  | { kind: 'ephemeral' | 'source' | 'local' | 'unknown' }
  | { kind: 'global'; manager: Manager };

/**
 * The nearest manifest named `demoflow` or `@demoflow/cli` above `from`, as
 * `packageVersion()` finds it, with symlinks resolved: a global bin is a link.
 */
export function packageLocation(
  from: string = import.meta.url,
): PackageLocation | null {
  let dir = realpathSync(path.dirname(fileURLToPath(from)));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      const { name } = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: unknown;
      };
      if (name === 'demoflow' || name === '@demoflow/cli') return { dir, name };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A path with `/` separators, lower-case on Windows, ending in `/`. */
function normalize(value: string, platform: NodeJS.Platform): string {
  let out = value.replaceAll('\\', '/');
  if (platform === 'win32') out = out.toLowerCase();
  return out.endsWith('/') ? out : `${out}/`;
}

/** The directories npm's global prefix may be, from the environment and Node's own location. */
function npmPrefixes(host: HostEnvironment, execPath: string): string[] {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  const prefixes = [host.env.npm_config_prefix, host.env.PREFIX];
  if (host.platform === 'win32') {
    prefixes.push(p.dirname(execPath));
    if (host.env.APPDATA) prefixes.push(p.join(host.env.APPDATA, 'npm'));
  } else {
    prefixes.push(p.dirname(p.dirname(execPath)));
  }
  return prefixes.filter((value): value is string => !!value);
}

export function detectInstall(
  pkg: PackageLocation,
  host: HostEnvironment,
  execPath: string,
): Install {
  if (pkg.name === '@demoflow/cli') return { kind: 'source' };
  const { platform, env } = host;
  const dir = normalize(pkg.dir, platform);
  const under = (base: string | undefined, rest: string) =>
    !!base && dir.startsWith(normalize(base, platform) + rest);

  if (
    env.npm_command === 'exec' ||
    ['/_npx/', '/bunx-', '/dlx/', '/dlx-'].some((part) => dir.includes(part))
  ) {
    return { kind: 'ephemeral' };
  }
  if (
    under(env.BUN_INSTALL, 'install/global/') ||
    dir.includes('/.bun/install/global/')
  ) {
    return { kind: 'global', manager: 'bun' };
  }
  if (under(env.PNPM_HOME, 'global/') || dir.includes('/pnpm/global/')) {
    return { kind: 'global', manager: 'pnpm' };
  }
  if (
    dir.includes('/yarn/global/node_modules/') ||
    dir.includes('/yarn/data/global/node_modules/')
  ) {
    return { kind: 'global', manager: 'yarn' };
  }
  const modules =
    platform === 'win32'
      ? 'node_modules/demoflow/'
      : 'lib/node_modules/demoflow/';
  if (
    npmPrefixes(host, execPath).some(
      (prefix) => normalize(prefix, platform) + modules === dir,
    ) ||
    (platform !== 'win32' && dir.endsWith('/lib/node_modules/demoflow/'))
  ) {
    return { kind: 'global', manager: 'npm' };
  }
  if (dir.endsWith('/node_modules/demoflow/')) return { kind: 'local' };
  return { kind: 'unknown' };
}

/** The global install of `version` by `manager`, as a program and its arguments. */
export function installCommand(
  manager: Manager,
  version: string,
): [string, ...string[]] {
  const spec = `demoflow@${version}`;
  switch (manager) {
    case 'npm':
      return ['npm', 'install', '-g', spec];
    case 'bun':
      return ['bun', 'add', '-g', spec];
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
  }
}
