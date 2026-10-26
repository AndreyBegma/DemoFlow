import { CliError } from '../config/index.ts';

/** Production; staging is reachable with `--server` or `DEMOFLOW_SERVER`. */
export const DEFAULT_SERVER = 'https://demoflow.luna-realm.com';

/** `--server`, then `DEMOFLOW_SERVER`, then the default. Returns an origin-and-path without a trailing slash. */
export function resolveServer(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = [flag, env.DEMOFLOW_SERVER].find(
    (value) => value !== undefined && value !== '',
  );
  return normalizeServer(raw ?? DEFAULT_SERVER);
}

export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(value);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid(value);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** The API sits behind `/api` on the same origin as the website. */
export function apiBase(server: string): string {
  return `${server}/api`;
}

function invalid(value: string): CliError {
  return new CliError(
    'invalid-server',
    `"${value}" is not an http(s) URL; use --server https://host or DEMOFLOW_SERVER`,
  );
}
