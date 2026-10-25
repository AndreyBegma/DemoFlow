import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type FragmentSource,
  type ProjectConfig,
  parseScenario,
} from '@demoflow/core';
import { CommandError } from '../commands/errors.ts';
import { loadScenario } from '../commands/scenario-file.ts';
import {
  CliError,
  findProjectRoot,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  PROJECT_CONFIG_FILE,
  projectFragments,
  resolveHome,
} from '../config/index.ts';
import { ToolError } from './errors.ts';

/** A project as `demoflow run` sees it: its root, config and artifacts home. */
export interface McpProject {
  root: string;
  config: ProjectConfig;
  home: string;
}

/**
 * The `project` argument (an absolute path; the server's working directory
 * when absent) → the project root, found as the CLI finds it: the directory
 * itself or its nearest ancestor with `demoflow.config.json`.
 */
export function resolveProject(
  project: string | undefined,
  cwd: string,
  host: HostEnvironment,
): McpProject {
  if (project !== undefined && !path.isAbsolute(project)) {
    throw new ToolError(
      'project-not-found',
      `project must be an absolute path: ${JSON.stringify(project)}`,
      'Pass the absolute path of the directory that holds demoflow.config.json.',
    );
  }
  const start = project ?? cwd;
  if (!isDirectory(start)) {
    throw new ToolError(
      'project-not-found',
      `no such directory: ${start}`,
      'Pass the absolute path of the directory that holds demoflow.config.json.',
    );
  }
  let root: string;
  try {
    // findProjectRoot starts at the file's directory: `start` itself.
    root = findProjectRoot(path.join(start, PROJECT_CONFIG_FILE));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new ToolError(
      'project-not-found',
      `no ${PROJECT_CONFIG_FILE} in ${start} or any parent directory`,
      project === undefined
        ? 'Pass `project`: the server was not started inside a DemoFlow project.'
        : `Create ${PROJECT_CONFIG_FILE} in the project, or pass another path.`,
    );
  }
  try {
    const config = loadProjectConfig(root);
    // As `demoflow run` resolves it: the child runs with the root as its cwd.
    const { home } = resolveHome({
      ...host,
      cwd: root,
      projectRoot: root,
      projectConfig: config,
      globalConfig: loadGlobalConfig(host),
    });
    return { root, config, home };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new ToolError(
      'invalid-project-config',
      error.message,
      `Fix ${PROJECT_CONFIG_FILE} (or the global config) and call again.`,
      error.issues,
    );
  }
}

/**
 * The `file` argument → the absolute path of a valid `*.demo.json` inside the
 * project. Resolved against the root; real paths are compared, so a symlink
 * cannot lead out of it. Its includes come from the project's `fragmentsDir`.
 */
export function resolveScenarioFile(
  root: string,
  file: string,
  fragmentsDir?: string,
): string {
  const absolute = path.resolve(root, file);
  const outside = new ToolError(
    'file-not-in-project',
    `${file} is not a *.demo.json file inside ${root}`,
    'Pass the path of a *.demo.json file inside the project, or an inline `scenario`.',
  );
  if (!absolute.endsWith('.demo.json') || !isInside(root, absolute)) {
    throw outside;
  }
  if (!existsSync(absolute)) {
    throw new ToolError(
      'scenario-unreadable',
      `no such file: ${absolute}`,
      'Check the path; it is resolved against the project root.',
    );
  }
  if (!isInside(realpathSync(root), realpathSync(absolute))) throw outside;
  try {
    loadScenario(absolute, projectFragments(root, fragmentsDir));
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw new ToolError(
      error.code === 'invalid-scenario'
        ? 'invalid-scenario'
        : 'scenario-unreadable',
      error.message,
      error.code === 'invalid-scenario'
        ? 'Fix the scenario at the paths in `issues` and call again.'
        : 'The file must be readable JSON.',
      error.issues,
    );
  }
  return absolute;
}

/**
 * An inline `scenario` checked against `ScenarioSchema` before it is queued;
 * its includes come from `fragments`, without which an include is an issue.
 */
export function checkInlineScenario(
  raw: unknown,
  fragments?: FragmentSource,
): void {
  const parsed = parseScenario(raw, { fragments });
  if (!parsed.ok) {
    throw new ToolError(
      'invalid-scenario',
      'the inline scenario is not a valid scenario',
      'Fix the scenario at the paths in `issues` and call again.',
      parsed.errors,
    );
  }
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
