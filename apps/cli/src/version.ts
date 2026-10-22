import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version of the `demoflow` package this module ships in: the nearest
 * `package.json` named `demoflow` (the published name) or `@demoflow/cli` (the
 * workspace name) above it. That is `apps/cli/package.json` in the workspace
 * and the published manifest in an install.
 */
export function packageVersion(from: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(from));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        (manifest.name === 'demoflow' || manifest.name === '@demoflow/cli') &&
        typeof manifest.version === 'string'
      )
        return manifest.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`no demoflow package.json above ${from}`);
    dir = parent;
  }
}
