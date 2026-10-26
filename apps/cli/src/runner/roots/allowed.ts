import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type HostEnvironment, pathFor } from '../../config/platform.ts';

/** Decision 1: the list holds at most this many roots. */
export const ALLOWED_ROOTS_MAX = 32;
/** Decision 3: a path longer than this is never allowed. */
export const PATH_MAX_LENGTH = 4096;

/**
 * Decision 1: what `allowed-roots.json` says. `default` is the home directory
 * of a machine without the file; `invalid` is a file that does not parse,
 * which allows nothing.
 */
export type AllowedRoots =
  | { source: 'default' | 'file'; roots: string[] }
  | { source: 'invalid'; roots: [] };

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/** Absolute for the host, at most 4,096 characters, no NUL. */
export function isAbsoluteFor(
  value: unknown,
  platform: NodeJS.Platform,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PATH_MAX_LENGTH ||
    value.includes('\0')
  ) {
    return false;
  }
  // A drive letter only: `\foo` is drive-relative and UNC or device paths
  // (`\\server`, `\\?\`) are refused.
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value);
  return pathFor(platform).isAbsolute(value);
}

/**
 * The roots in force, read afresh on every call so the daemon needs no
 * restart. Never throws; anything but a missing file that does not parse is
 * `invalid`, so a broken file never widens access.
 */
export function readAllowedRoots(
  file: string,
  host: HostEnvironment,
): AllowedRoots {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { source: 'default', roots: [host.homedir] };
    }
    return { source: 'invalid', roots: [] };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    const { roots } = parsed as Record<string, unknown>;
    if (
      !Array.isArray(roots) ||
      roots.length > ALLOWED_ROOTS_MAX ||
      !roots.every((root) => isAbsoluteFor(root, host.platform))
    ) {
      throw new Error();
    }
    return { source: 'file', roots: roots as string[] };
  } catch {
    return { source: 'invalid', roots: [] };
  }
}

/** Written atomically with mode 600, like `credentials.json`. */
export function writeAllowedRoots(
  file: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
): void {
  const p = pathFor(platform);
  mkdirSync(p.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ roots }, null, 2)}\n`, {
      mode: 0o600,
    });
    // `mode` is masked by the umask and ignored on an existing file.
    if (platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
