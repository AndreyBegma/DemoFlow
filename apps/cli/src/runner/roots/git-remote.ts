import { pathFor } from '../../config/platform.ts';
import type { LaunchFs } from '../launch/checks.ts';
import { realRoots, segmentsBelow } from './path-rule.ts';

/** Decision 6: a git config file is read only up to this size. */
export const GIT_CONFIG_MAX_BYTES = 64 * 1024;
/** A `.git` file or `commondir` is one short line. */
const GIT_POINTER_MAX_BYTES = 4096;

const NAME = '[A-Za-z0-9._-]{1,100}';
const GITHUB_REMOTES = [
  new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/?$`),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME})$`),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME})/?$`),
];

/**
 * Decision 6: `https://github.com/<owner>/<repo>` for an https, scp-style or
 * ssh remote on github.com; anything else — another host, a port, a URL with
 * credentials — is `undefined`.
 */
export function githubUrlFrom(remote: string): string | undefined {
  for (const pattern of GITHUB_REMOTES) {
    const match = pattern.exec(remote);
    if (match === null) continue;
    const owner = match[1] as string;
    const repo = (match[2] as string).replace(/\.git$/, '');
    if ([owner, repo].some((name) => /^\.*$/.test(name))) return undefined;
    return `https://github.com/${owner}/${repo}`;
  }
  return undefined;
}

/** The first `url` of `[remote "origin"]` in a git config file, unquoted. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(
      line,
    );
    if (section !== null) {
      // Section names ignore case; subsection names do not.
      inOrigin =
        section[1]?.toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    if (!inOrigin) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (entry === null) continue;
    let value = (entry[1] as string).trim();
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end === -1 ? '' : value.slice(1, end);
    } else {
      value = value.replace(/\s[#;].*$/, '').trim();
    }
    return value;
  }
  return undefined;
}

async function readRegularFile(
  file: string,
  maxBytes: number,
  fs: LaunchFs,
): Promise<string> {
  if (!(await fs.lstat(file)).isFile()) throw new Error('not a file');
  return fs.readFile(file, maxBytes);
}

/**
 * Decision 6: the GitHub URL of the canonical folder `root`'s `origin`, read
 * from its git config without running git. A `.git` file is followed one
 * level (to its `gitdir`, and from a worktree's gitdir to its `commondir`),
 * and only to a directory inside an allowed root. Never throws.
 */
export async function githubUrlOf(
  root: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
  fs: LaunchFs,
): Promise<string | undefined> {
  const p = pathFor(platform);
  try {
    const dotGit = p.join(root, '.git');
    const stats = await fs.lstat(dotGit);
    let config: string;
    if (stats.isDirectory()) {
      config = await readRegularFile(
        p.join(dotGit, 'config'),
        GIT_CONFIG_MAX_BYTES,
        fs,
      );
    } else if (stats.isFile()) {
      const allowed = await realRoots(roots, fs);
      const follow = async (from: string, value: string) => {
        const target = await fs.realpath(p.resolve(from, value.trim()));
        if (!allowed.some((r) => segmentsBelow(target, r, platform) !== null)) {
          throw new Error('outside the allowed roots');
        }
        if (!(await fs.lstat(target)).isDirectory()) {
          throw new Error('not a directory');
        }
        return target;
      };
      const pointer = await readRegularFile(dotGit, GIT_POINTER_MAX_BYTES, fs);
      const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1];
      if (gitdir === undefined) return undefined;
      const dir = await follow(root, gitdir);
      try {
        config = await readRegularFile(
          p.join(dir, 'config'),
          GIT_CONFIG_MAX_BYTES,
          fs,
        );
      } catch {
        // A worktree's gitdir keeps its config in the common directory.
        const common = await readRegularFile(
          p.join(dir, 'commondir'),
          GIT_POINTER_MAX_BYTES,
          fs,
        );
        config = await readRegularFile(
          p.join(await follow(dir, common), 'config'),
          GIT_CONFIG_MAX_BYTES,
          fs,
        );
      }
    } else {
      return undefined;
    }
    const url = originUrl(config);
    return url === undefined ? undefined : githubUrlFrom(url);
  } catch {
    return undefined;
  }
}
