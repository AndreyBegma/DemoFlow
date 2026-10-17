import { readFileSync } from 'node:fs';
import type { ProjectConfig } from '@demoflow/core';
import { CliError } from './errors.ts';
import { absoluteEnv, type HostEnvironment, pathFor } from './platform.ts';

/** `<home>` → `<home>/runs/<runId>` (ADR-0004 §7). */
export function runDir(
  home: string,
  runId: string,
  platform: NodeJS.Platform,
): string {
  return pathFor(platform).join(home, 'runs', runId);
}

/**
 * Global config location: `$XDG_CONFIG_HOME/demoflow/config.json` or
 * `~/.config/demoflow/config.json`; `~/Library/Application Support/demoflow/config.json`;
 * `%APPDATA%\demoflow\config.json`.
 */
export function globalConfigPath(host: HostEnvironment): string {
  const p = pathFor(host.platform);
  if (host.platform === 'darwin') {
    return p.join(
      host.homedir,
      'Library',
      'Application Support',
      'demoflow',
      'config.json',
    );
  }
  if (host.platform === 'win32') {
    const appData =
      absoluteEnv(host, 'APPDATA') ??
      p.join(host.homedir, 'AppData', 'Roaming');
    return p.join(appData, 'demoflow', 'config.json');
  }
  const configHome =
    absoluteEnv(host, 'XDG_CONFIG_HOME') ?? p.join(host.homedir, '.config');
  return p.join(configHome, 'demoflow', 'config.json');
}

/**
 * The OS data directory: `$XDG_DATA_HOME/demoflow` or `~/.local/share/demoflow`;
 * `~/Library/Application Support/demoflow`; `%LOCALAPPDATA%\demoflow`.
 */
export function osDataDir(host: HostEnvironment): string {
  const p = pathFor(host.platform);
  if (host.platform === 'darwin') {
    return p.join(host.homedir, 'Library', 'Application Support', 'demoflow');
  }
  if (host.platform === 'win32') {
    const local =
      absoluteEnv(host, 'LOCALAPPDATA') ??
      p.join(host.homedir, 'AppData', 'Local');
    return p.join(local, 'demoflow');
  }
  const dataHome =
    absoluteEnv(host, 'XDG_DATA_HOME') ??
    p.join(host.homedir, '.local', 'share');
  return p.join(dataHome, 'demoflow');
}

export interface GlobalConfig {
  /** Absolute: a relative value is resolved against the config file's directory. */
  artifactsDir?: string;
}

/**
 * Reads the global config. Only `artifactsDir` is read. A missing file is an
 * empty config; a malformed one is `invalid-global-config`.
 */
export function loadGlobalConfig(
  host: HostEnvironment,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): GlobalConfig {
  const file = globalConfigPath(host);
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw invalid(file, error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalid(file, error instanceof Error ? error.message : String(error));
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid(file, 'expected a JSON object');
  }
  const { artifactsDir } = raw as { artifactsDir?: unknown };
  if (artifactsDir === undefined) return {};
  if (typeof artifactsDir !== 'string' || artifactsDir === '') {
    throw invalid(file, '"artifactsDir" must be a non-empty string');
  }
  const p = pathFor(host.platform);
  return { artifactsDir: p.resolve(p.dirname(file), artifactsDir) };
}

function invalid(file: string, reason: string): CliError {
  return new CliError(
    'invalid-global-config',
    `global config ${file} is invalid: ${reason}`,
  );
}

export type HomeSource =
  | 'out'
  | 'env'
  | 'project-config'
  | 'global-config'
  | 'os-data-dir';

export interface ResolveHomeInput extends HostEnvironment {
  /** The `--out` flag. */
  out?: string;
  /** For resolving a relative `--out` or `DEMOFLOW_HOME`. */
  cwd: string;
  projectRoot: string;
  projectConfig: Pick<ProjectConfig, 'artifactsDir'>;
  globalConfig: GlobalConfig;
}

/** First hit wins: `--out`, `DEMOFLOW_HOME`, project `artifactsDir`, global `artifactsDir`, OS data dir. */
export function resolveHome(input: ResolveHomeInput): {
  home: string;
  source: HomeSource;
} {
  const p = pathFor(input.platform);
  if (input.out !== undefined && input.out !== '') {
    return { home: p.resolve(input.cwd, input.out), source: 'out' };
  }
  const fromEnv = input.env.DEMOFLOW_HOME;
  if (fromEnv !== undefined && fromEnv !== '') {
    return { home: p.resolve(input.cwd, fromEnv), source: 'env' };
  }
  if (input.projectConfig.artifactsDir !== undefined) {
    return {
      home: p.resolve(input.projectRoot, input.projectConfig.artifactsDir),
      source: 'project-config',
    };
  }
  if (input.globalConfig.artifactsDir !== undefined) {
    return { home: input.globalConfig.artifactsDir, source: 'global-config' };
  }
  return { home: osDataDir(input), source: 'os-data-dir' };
}
