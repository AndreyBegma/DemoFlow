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

  const files: [string, unknown][] = [
    [PROJECT_CONFIG_FILE, config],
    [FIRST_SCENARIO, FIRST_SCENARIO_TEMPLATE],
  ];
  for (const [rel, content] of files) {
    const created = await createExclusive(deps.cwd, rel, content);
    io.stdout(`${created ? 'created' : 'kept'} ${rel}\n`);
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

/** `false` when the file already exists; it is left untouched. */
async function createExclusive(
  cwd: string,
  rel: string,
  content: unknown,
): Promise<boolean> {
  const file = path.join(cwd, ...rel.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, {
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
