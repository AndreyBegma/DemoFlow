import { pathFor } from '../../config/platform.ts';
import type { LaunchFs } from '../launch/checks.ts';
import { isAbsoluteFor } from './allowed.ts';

/** What the path rule touches: real paths and `lstat`, never a link followed. */
export type PathFs = Pick<LaunchFs, 'realpath' | 'lstat'>;

/** `ok` carries the canonical folder; a refusal says nothing more. */
export type PathCheck = { ok: true; root: string } | { ok: false };

/** Decision 3: Windows and macOS compare paths without case. */
function fold(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

function segments(value: string, platform: NodeJS.Platform): string[] {
  return value.split(platform === 'win32' ? /[\\/]/ : '/').filter(Boolean);
}

export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform,
): boolean {
  return fold(a, platform) === fold(b, platform);
}

/**
 * The segments of `child` below `parent`, compared segment-wise; `null` when
 * `child` is neither `parent` nor below it. Both are real paths.
 */
export function segmentsBelow(
  child: string,
  parent: string,
  platform: NodeJS.Platform,
): string[] | null {
  const inner = segments(child, platform);
  const outer = segments(parent, platform);
  if (outer.length > inner.length) return null;
  for (let i = 0; i < outer.length; i++) {
    if (!samePath(outer[i] as string, inner[i] as string, platform)) {
      return null;
    }
  }
  return inner.slice(outer.length);
}

/** The real paths of the roots that still resolve; a root that does not is skipped. */
export async function realRoots(
  roots: readonly string[],
  fs: PathFs,
): Promise<string[]> {
  const real: string[] = [];
  for (const root of roots) {
    try {
      real.push(await fs.realpath(root));
    } catch {
      // A root that is gone allows nothing.
    }
  }
  return real;
}

/**
 * Decision 3 (ADR-0022 §2): `raw` names a folder the website may use when it
 * is an absolute path for the host, its real path is the path itself (no link
 * or junction anywhere on the way, no `..` that leaves it), it is a
 * directory, and it is an allowed root or lies below one with no segment
 * below that root starting with `.`. Every failure is the same refusal.
 */
export async function isAllowedPath(
  raw: unknown,
  roots: readonly string[],
  platform: NodeJS.Platform,
  fs: PathFs,
): Promise<PathCheck> {
  const refused = { ok: false } as const;
  if (!isAbsoluteFor(raw, platform)) return refused;
  let real: string;
  try {
    // The OS resolves `..` after links, so `link/..` lands where the link
    // points and differs from the lexical form below.
    real = await fs.realpath(raw);
    if (!samePath(real, pathFor(platform).resolve(raw), platform)) {
      return refused;
    }
    if (!(await fs.lstat(real)).isDirectory()) return refused;
  } catch {
    return refused;
  }
  for (const root of await realRoots(roots, fs)) {
    const below = segmentsBelow(real, root, platform);
    if (below?.every((segment) => !segment.startsWith('.'))) {
      return { ok: true, root: real };
    }
  }
  return refused;
}
