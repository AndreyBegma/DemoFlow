import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectConfig } from '@demoflow/core';
import { EXIT_INVALID_INPUT, PROJECT_CONFIG_FILE } from '../config/index.ts';
import type { Io } from './io.ts';

export interface InitFlags {
  baseUrl?: string;
}

export interface InitDeps {
  cwd: string;
}

export const DEFAULT_BASE_URL = 'http://localhost:3000';

/** The directory of a project that holds its scenarios (as `check` lists). */
const SCENARIO_DIR = 'demoflow';
const FIRST_SCENARIO = `${SCENARIO_DIR}/first.demo.json`;

/**
 * Passes against any app that answers at `baseUrl`, so the first `demoflow run`
 * produces a video instead of a failed locator.
 */
export const FIRST_SCENARIO_TEMPLATE = {
  schemaVersion: 1,
  name: 'First demo',
  steps: [
    { action: 'navigate', path: '/', caption: 'Open the app' },
    { action: 'wait', ms: 1000 },
  ],
};

/**
 * `demoflow init` (spec 273): writes `demoflow.config.json` and a first
 * scenario in the current directory. Never overwrites: an existing file is
 * kept. No browser, no network.
 */
export async function initCommand(
  flags: InitFlags,
  io: Io,
  deps: InitDeps = { cwd: process.cwd() },
): Promise<number> {
  const config = { baseUrl: flags.baseUrl ?? DEFAULT_BASE_URL };
  const parsed = parseProjectConfig(config);
  if (!parsed.ok) {
    io.stderr(
      `${parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n')}\n`,
    );
    return EXIT_INVALID_INPUT;
  }

  const written = await writeInitTemplate(deps.cwd, {
    baseUrl: config.baseUrl,
  });
  for (const rel of INIT_FILES) {
    io.stdout(`${written.created.includes(rel) ? 'created' : 'kept'} ${rel}\n`);
  }
  io.stdout(
    [
      '',
      'next:',
      '  demoflow check                              check FFmpeg and the browser',
      `  demoflow run ${FIRST_SCENARIO}    run the first scenario`,
      '  demoflow record <name>                      record a real scenario',
      '',
    ].join('\n'),
  );
  return 0;
}

/** The files `demoflow init` writes, in the order it reports them. */
export const INIT_FILES = [PROJECT_CONFIG_FILE, FIRST_SCENARIO] as const;

export interface InitTemplateOptions {
  baseUrl?: string;
  /**
   * Spec 377: for a folder the website named, a file is never written through
   * a linked directory, which could point anywhere; it throws instead.
   */
  noLinks?: boolean;
}

export interface InitTemplateResult {
  created: string[];
  kept: string[];
}

/**
 * The file-writing half of `demoflow init`, shared with the runner's
 * `project.init` (spec 377, Decision 7): the config and the first scenario,
 * each created only when it does not exist yet.
 */
export async function writeInitTemplate(
  root: string,
  options: InitTemplateOptions = {},
): Promise<InitTemplateResult> {
  const contents: Record<(typeof INIT_FILES)[number], unknown> = {
    [PROJECT_CONFIG_FILE]: { baseUrl: options.baseUrl ?? DEFAULT_BASE_URL },
    [FIRST_SCENARIO]: FIRST_SCENARIO_TEMPLATE,
  };
  const result: InitTemplateResult = { created: [], kept: [] };
  for (const rel of INIT_FILES) {
    const created = await createExclusive(
      root,
      rel,
      contents[rel],
      options.noLinks === true,
    );
    (created ? result.created : result.kept).push(rel);
  }
  return result;
}

/** `false` when the file already exists; it is left untouched. */
async function createExclusive(
  cwd: string,
  rel: string,
  content: unknown,
  noLinks: boolean,
): Promise<boolean> {
  const file = path.join(cwd, ...rel.split('/'));
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  if (noLinks && realpathSync.native(dir) !== dir) {
    throw new Error(`${path.dirname(rel)} is reached through a link`);
  }
  try {
    // `wx` also refuses a link in the file's place, dangling or not.
    await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, {
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
