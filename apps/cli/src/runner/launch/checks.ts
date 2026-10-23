import { realpathSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseScenario } from '@demoflow/core';
import { PROJECT_CONFIG_FILE } from '../../config/index.ts';
import { knownRoots } from '../../runs-report/reported-runs.ts';
import { isScenarioId } from './scenario-id.ts';

/** Decision 4: a scenario file is read only up to this size. */
export const SCENARIO_MAX_BYTES = 1024 * 1024;

export interface LaunchStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface LaunchEntry extends LaunchStats {
  name: string;
}

/** The filesystem the checks and the listing touch; never follows a link. */
export interface LaunchFs {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<LaunchStats>;
  /** The entries of a directory, as `lstat` sees them. */
  readdir(dir: string): Promise<LaunchEntry[]>;
  /** At most `maxBytes`; a longer file throws `TooLargeError`. */
  readFile(file: string, maxBytes: number): Promise<string>;
}

export class TooLargeError extends Error {}

export const nodeLaunchFs: LaunchFs = {
  // `.native` also expands Windows 8.3 short names, as `canonicalRoot` does.
  realpath: async (file) => realpathSync.native(file),
  lstat: (file) => lstat(file),
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: async (file, maxBytes) => {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new TooLargeError(`over ${maxBytes} bytes`);
      return buffer.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  },
};

/** What loading the project's config says; injected so tests need no engine. */
export type ProjectLoad =
  | { ok: true; home: string }
  | { ok: false; code: 'config-invalid' | 'project-unknown' };

export interface CheckDeps {
  /** `reported-runs.jsonl`: the registry (Decision 1). */
  indexFile: string;
  fs: LaunchFs;
  loadProject(root: string): ProjectLoad;
}

export type ProjectCheck =
  | { ok: true; root: string; home: string }
  | { ok: false; code: 'project-unknown' | 'config-invalid' };

/**
 * Decision 2: the root is a key into this machine's registry, never a place
 * to go. Nothing below it is read unless it is registered, still canonical,
 * a directory, and holds `demoflow.config.json`.
 */
export async function checkProject(
  rootPath: string,
  deps: CheckDeps,
): Promise<ProjectCheck> {
  const unknown = { ok: false, code: 'project-unknown' } as const;
  if (!(await knownRoots(deps.indexFile)).has(rootPath)) return unknown;
  try {
    if ((await deps.fs.realpath(rootPath)) !== rootPath) return unknown;
    if (!(await deps.fs.lstat(rootPath)).isDirectory()) return unknown;
    const config = await deps.fs.lstat(
      path.join(rootPath, PROJECT_CONFIG_FILE),
    );
    if (!config.isFile()) return unknown;
  } catch {
    return unknown;
  }
  const loaded = deps.loadProject(rootPath);
  if (!loaded.ok) return loaded;
  return { ok: true, root: rootPath, home: loaded.home };
}

export type ScenarioCheck =
  | { ok: true; file: string; name: string }
  | { ok: false; code: 'scenario-not-found' | 'scenario-invalid' };

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * Decisions 3 and 4: the id follows the rule, and the file it names is a
 * regular file whose real path is that path, so no link below the root is
 * followed. It is read up to 1 MiB and parsed as a scenario.
 */
export async function checkScenario(
  root: string,
  id: string,
  fs: LaunchFs,
): Promise<ScenarioCheck> {
  const notFound = { ok: false, code: 'scenario-not-found' } as const;
  const invalid = { ok: false, code: 'scenario-invalid' } as const;
  if (!isScenarioId(id)) return notFound;
  const file = path.resolve(root, ...id.split('/'));
  try {
    if (!(await fs.lstat(file)).isFile()) return notFound;
    if ((await fs.realpath(file)) !== file) return notFound;
  } catch {
    return notFound;
  }
  let text: string;
  try {
    text = await fs.readFile(file, SCENARIO_MAX_BYTES);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? notFound : invalid;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid;
  }
  const parsed = parseScenario(json);
  if (!parsed.ok) return invalid;
  return { ok: true, file, name: parsed.value.name };
}
