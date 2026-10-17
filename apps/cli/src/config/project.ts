import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type ProjectConfig, parseProjectConfig } from '@demoflow/core';
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

/** The scenario's path relative to the project root, with `/` separators on every OS. */
export function scenarioId(
  root: string,
  scenarioPath: string,
  pathApi: path.PlatformPath = path,
): string {
  const relative = pathApi.relative(root, pathApi.resolve(root, scenarioPath));
  return relative.split(pathApi.sep).join('/');
}

/** Reads and validates `<root>/demoflow.config.json`. */
export function loadProjectConfig(root: string): ProjectConfig {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      'invalid-config',
      `cannot read ${PROJECT_CONFIG_FILE}: ${reason}`,
    );
  }
  const parsed = parseProjectConfig(raw);
  if (!parsed.ok) {
    throw new CliError(
      'invalid-config',
      `${PROJECT_CONFIG_FILE} is invalid`,
      parsed.errors,
    );
  }
  return parsed.value;
}
