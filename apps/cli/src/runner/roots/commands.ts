import { realpathSync, statSync } from 'node:fs';
import type { Io } from '../../commands/io.ts';
import { EXIT_INVALID_INPUT } from '../../config/index.ts';
import { type HostEnvironment, pathFor } from '../../config/platform.ts';
import { runnerPaths } from '../paths.ts';
import {
  ALLOWED_ROOTS_MAX,
  type AllowedRoots,
  readAllowedRoots,
  writeAllowedRoots,
} from './allowed.ts';
import { samePath } from './path-rule.ts';

export interface RootsDeps {
  host: HostEnvironment;
  cwd: string;
}

function invalidNote(file: string): string {
  return `${file} is invalid: every folder is refused until it is fixed or removed`;
}

/**
 * `demoflow runner roots [--json]` (spec 377, Decision 2): the roots in
 * force, the default marked. Exits 1 when the file is invalid.
 */
export function rootsCommand(
  flags: { json?: boolean },
  io: Io,
  deps: RootsDeps,
): number {
  const file = runnerPaths(deps.host).allowedRoots;
  const allowed = readAllowedRoots(file, deps.host);
  const valid = allowed.source !== 'invalid';
  if (flags.json === true) {
    io.stdout(
      `${JSON.stringify({ roots: allowed.roots, default: allowed.source === 'default', valid })}\n`,
    );
    return valid ? 0 : 1;
  }
  if (!valid) {
    io.stderr(`${invalidNote(file)}\n`);
    return 1;
  }
  if (allowed.roots.length === 0) {
    io.stdout('No allowed roots: the website may name no folder\n');
    return 0;
  }
  for (const root of allowed.roots) {
    io.stdout(
      `${root}${allowed.source === 'default' ? '  (default: the home directory)' : ''}\n`,
    );
  }
  return 0;
}

/**
 * `demoflow runner allow <dir>`: adds the real path of an existing
 * directory. The first `allow` on a machine without the file replaces the
 * default home directory (Decision 2).
 */
export function allowCommand(dir: string, io: Io, deps: RootsDeps): number {
  const { platform } = deps.host;
  const resolved = pathFor(platform).resolve(deps.cwd, dir);
  let real: string;
  try {
    if (!statSync(resolved).isDirectory()) throw new Error();
    real = realpathSync.native(resolved);
  } catch {
    io.stderr(`Not a directory: ${resolved}\n`);
    return EXIT_INVALID_INPUT;
  }
  const file = runnerPaths(deps.host).allowedRoots;
  const allowed = readAllowedRoots(file, deps.host);
  const current = allowed.source === 'file' ? allowed.roots : [];
  if (current.some((root) => samePath(root, real, platform))) {
    io.stdout(`Already allowed: ${real}\n`);
    return 0;
  }
  if (current.length >= ALLOWED_ROOTS_MAX) {
    io.stderr(
      `At most ${ALLOWED_ROOTS_MAX} allowed roots; disallow one first\n`,
    );
    return EXIT_INVALID_INPUT;
  }
  writeAllowedRoots(file, [...current, real], platform);
  io.stdout(`Allowed: ${real}\n`);
  printReplaced(allowed, real, io, deps.host);
  return 0;
}

function printReplaced(
  allowed: AllowedRoots,
  added: string,
  io: Io,
  host: HostEnvironment,
): void {
  if (allowed.source === 'invalid') {
    io.stdout('The invalid allowed-roots file was replaced\n');
  } else if (
    allowed.source === 'default' &&
    !samePath(added, realOrResolved(host.homedir, host.platform), host.platform)
  ) {
    io.stdout(
      `The home directory (${host.homedir}) is no longer allowed; allow it again to keep it\n`,
    );
  }
}

function realOrResolved(dir: string, platform: NodeJS.Platform): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return pathFor(platform).resolve(dir);
  }
}

/**
 * `demoflow runner disallow <dir>`: removes the entry equal to the folder's
 * real path, or its resolved path once it is gone. Removing the last one
 * allows nothing, never the default again (Decision 2).
 */
export function disallowCommand(dir: string, io: Io, deps: RootsDeps): number {
  const { platform } = deps.host;
  const target = realOrResolved(
    pathFor(platform).resolve(deps.cwd, dir),
    platform,
  );
  const file = runnerPaths(deps.host).allowedRoots;
  const allowed = readAllowedRoots(file, deps.host);
  if (allowed.source === 'invalid') {
    io.stderr(`${invalidNote(file)}\n`);
    return 1;
  }
  const matches = (root: string) =>
    samePath(root, target, platform) ||
    samePath(realOrResolved(root, platform), target, platform);
  const kept = allowed.roots.filter((root) => !matches(root));
  if (kept.length === allowed.roots.length) {
    io.stderr(`Not an allowed root: ${target}\n`);
    return 1;
  }
  writeAllowedRoots(file, kept, platform);
  io.stdout(`Disallowed: ${target}\n`);
  if (kept.length === 0) {
    io.stdout('No allowed roots left: the website may name no folder\n');
  }
  return 0;
}
