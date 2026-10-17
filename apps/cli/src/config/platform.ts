import { homedir } from 'node:os';
import path from 'node:path';

/** What path, home and environment lookups need; injected so tests can fake an OS. */
export interface HostEnvironment {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}

/** The path module that builds paths with the platform's rules. */
export function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** An environment variable that is set, non-empty and an absolute path. */
export function absoluteEnv(
  host: HostEnvironment,
  name: string,
): string | undefined {
  const value = host.env[name];
  if (value === undefined || value === '') return undefined;
  return pathFor(host.platform).isAbsolute(value) ? value : undefined;
}

export function currentHost(): HostEnvironment {
  return { platform: process.platform, env: process.env, homedir: homedir() };
}
