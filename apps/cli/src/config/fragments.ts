import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_FRAGMENTS_DIR,
  type FragmentLoad,
  type FragmentSource,
} from '@demoflow/core';
import { findProjectRoot, loadProjectConfig } from './project.ts';

/** A fragment file is as small as a scenario: at most 1 MiB. */
export const FRAGMENT_MAX_BYTES = 1024 * 1024;

/**
 * The fragments of the project at `root` (ADR-0018): `<name>.json` below
 * `fragmentsDir`, named in messages by their path relative to the root.
 * Real paths are compared, so neither `fragmentsDir` nor a symlink can lead
 * out of the project.
 */
export function projectFragments(
  root: string,
  fragmentsDir: string = DEFAULT_FRAGMENTS_DIR,
  pathApi: path.PlatformPath = path,
): FragmentSource {
  const dir = pathApi.resolve(root, fragmentsDir);
  return (name) => {
    const absolute = `${pathApi.join(dir, ...name.split('/'))}.json`;
    const file = pathApi.relative(root, absolute).split(pathApi.sep).join('/');
    const fail = (missing: boolean, message: string): FragmentLoad => ({
      ok: false,
      file,
      missing,
      message,
    });
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch (error) {
      return errorCode(error) === 'ENOENT'
        ? fail(true, 'no such file')
        : fail(false, reason(error));
    }
    if (!isInside(realpathSync(root), real, pathApi)) {
      return fail(false, 'it is outside the project');
    }
    try {
      if (statSync(real).size > FRAGMENT_MAX_BYTES) {
        return fail(false, `it is larger than ${FRAGMENT_MAX_BYTES} bytes`);
      }
      return { ok: true, file, value: JSON.parse(readFileSync(real, 'utf8')) };
    } catch (error) {
      return fail(false, reason(error));
    }
  };
}

/**
 * A source made only when a scenario first includes a fragment: a command
 * that needs no project for a plain scenario (`validate`) still needs none.
 * A failure to make it is reported at the include.
 */
export function lazyFragments(make: () => FragmentSource): FragmentSource {
  let source: FragmentSource | undefined;
  return (name) => {
    try {
      source ??= make();
    } catch (error) {
      return {
        ok: false,
        file: name,
        missing: false,
        message: `cannot find the project's fragments: ${reason(error)}`,
      };
    }
    return source(name);
  };
}

/**
 * The fragments of the project holding `scenarioPath`, found and configured
 * only when the scenario includes one.
 */
export function fragmentsNear(scenarioPath: string): FragmentSource {
  return lazyFragments(() => {
    const root = findProjectRoot(scenarioPath);
    return projectFragments(root, loadProjectConfig(root).fragmentsDir);
  });
}

function isInside(
  root: string,
  file: string,
  pathApi: path.PlatformPath,
): boolean {
  const relative = pathApi.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
