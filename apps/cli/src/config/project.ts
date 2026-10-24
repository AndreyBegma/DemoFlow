import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ConfigVariables,
  type ProjectConfig,
  parsePort,
  parseProjectConfig,
  resolveConfigTemplates,
} from '@demoflow/core';
import { CliError } from './errors.ts';

export const PROJECT_CONFIG_FILE = 'demoflow.config.json';

/**
 * The nearest ancestor directory of the scenario file that contains
 * `demoflow.config.json`. None → `no-project-config`.
 */
export function findProjectRoot(
  scenarioPath: string,
  fileExists: (file: string) => boolean = existsSync,
  pathApi: path.PlatformPath = path,
): string {
  let dir = pathApi.dirname(pathApi.resolve(scenarioPath));
  for (;;) {
    if (fileExists(pathApi.join(dir, PROJECT_CONFIG_FILE))) return dir;
    const parent = pathApi.dirname(dir);
    if (parent === dir) {
      throw new CliError(
        'no-project-config',
        `no ${PROJECT_CONFIG_FILE} found in ${scenarioPath} or any parent directory`,
      );
    }
    dir = parent;
  }
}

/**
 * A directory given as the project root (`run --project`): it must hold
 * `demoflow.config.json` itself — no search upwards.
 */
export function projectRootAt(
  dir: string,
  fileExists: (file: string) => boolean = existsSync,
  pathApi: path.PlatformPath = path,
): string {
  if (!fileExists(pathApi.join(dir, PROJECT_CONFIG_FILE))) {
    throw new CliError(
      'no-project-config',
      `no ${PROJECT_CONFIG_FILE} found in ${dir}`,
    );
  }
  return dir;
}

/** The project holding `dir`, searched upwards as for a scenario file. */
export function projectRootAbove(dir: string): string {
  try {
    // The walk starts at the directory of the path it is given.
    return findProjectRoot(path.join(dir, PROJECT_CONFIG_FILE));
  } catch (error) {
    if (error instanceof CliError && error.code === 'no-project-config') {
      throw new CliError(
        'no-project-config',
        `no ${PROJECT_CONFIG_FILE} found in ${dir} or any parent directory`,
      );
    }
    throw error;
  }
}

/**
 * The scenario's path relative to the project root, with `/` separators on
 * every OS. A file outside the root (an inline scenario staged by
 * `demoflow mcp`) is `inline/<file name>`.
 */
export function scenarioId(
  root: string,
  scenarioPath: string,
  pathApi: path.PlatformPath = path,
): string {
  const file = pathApi.resolve(root, scenarioPath);
  const relative = pathApi.relative(root, file);
  if (
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return `inline/${pathApi.basename(file)}`;
  }
  return relative.split(pathApi.sep).join('/');
}

/**
 * The port `${PORT}` takes in a command that never opens `baseUrl` or starts
 * the app: the config is validated, the port is never used (spec 337).
 */
const STAND_IN_PORT = 3000;

type Env = Readonly<Record<string, string | undefined>>;

/** `PORT` from the environment; an empty value counts as unset. */
function envPort(env: Env): string | undefined {
  const value = env.PORT;
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads and validates `<root>/demoflow.config.json` for a command that never
 * starts the app: `${PORT}` takes `PORT` from the environment when it is a
 * valid port, else a stand-in, so a config written for parallel runs still
 * loads where `PORT` is not set (spec 337, Decision 4).
 */
export function loadProjectConfig(
  root: string,
  env: Env = process.env,
): ProjectConfig {
  const fromEnv = envPort(env);
  const variables: ConfigVariables = {
    envPort:
      fromEnv !== undefined && parsePort(fromEnv) !== undefined
        ? fromEnv
        : undefined,
    standInPort: STAND_IN_PORT,
  };
  return parseConfig(readConfig(root), variables);
}

export interface AppConfigOptions {
  /** `--port`, already validated. */
  port?: number;
  /** `--base-url`: `${BASE_URL}` and `allowedOrigins` follow it. */
  baseUrl?: string;
  env?: Env;
}

export interface AppConfig {
  config: ProjectConfig;
  /** The port the run uses, to set as `PORT` for the app (Decision 6). */
  port?: number;
  /** Whether any field uses `${PORT}`. */
  usesPort: boolean;
}

/**
 * The config of a command that starts the app (`run`, `record`): `${PORT}`
 * is `--port`, else `PORT` from the environment, else the field's default,
 * and a `${PORT}` with none of them is `invalid-config` (spec 337).
 */
export function loadAppConfig(
  root: string,
  options: AppConfigOptions = {},
): AppConfig {
  const raw = readConfig(root);
  const variables: ConfigVariables = {
    port: options.port,
    envPort: envPort(options.env ?? process.env),
    baseUrl: options.baseUrl,
  };
  const config = parseConfig(raw, variables);
  const templated = resolveConfigTemplates(raw, variables);
  const usesPort = templated.ok && templated.usesPort;
  const port = options.port ?? (templated.ok ? templated.port : undefined);
  return { config, port, usesPort };
}

function readConfig(root: string): unknown {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      'invalid-config',
      `cannot read ${PROJECT_CONFIG_FILE}: ${reason}`,
    );
  }
}

function parseConfig(raw: unknown, variables: ConfigVariables): ProjectConfig {
  const parsed = parseProjectConfig(raw, variables);
  if (!parsed.ok) {
    throw new CliError(
      'invalid-config',
      `${PROJECT_CONFIG_FILE} is invalid`,
      parsed.errors,
    );
  }
  return parsed.value;
}
