import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Issue,
  parseScenario,
  type ScenarioInput,
  type Viewport,
} from '@demoflow/core';
import { EXIT_INVALID_INPUT } from '../config/index.ts';

export type RecordErrorCode =
  | 'invalid-name'
  | 'invalid-viewport'
  | 'scenario-exists'
  | 'nothing-recorded'
  | 'invalid-recording';

/** A `demoflow record` input problem: exit 2, like every input error (spec 5). */
export class RecordError extends Error {
  readonly code: RecordErrorCode;
  readonly exitCode = EXIT_INVALID_INPUT;
  readonly issues: Issue[];

  constructor(code: RecordErrorCode, message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'RecordError';
    this.code = code;
    this.issues = issues;
  }
}

/** `demoflow/<slug>.demo.json` under the project root. */
export function scenarioPath(root: string, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new RecordError(
      'invalid-name',
      `"${name}" has no letters or digits to name a file with`,
    );
  }
  return path.join(root, 'demoflow', `${slug}.demo.json`);
}

export function parseViewport(value: string): Viewport {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim());
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (match === null || width === 0 || height === 0) {
    throw new RecordError(
      'invalid-viewport',
      `expected a viewport such as 1280x720, got "${value}"`,
    );
  }
  return { width, height };
}

/** Checked before the browser starts, so a clash never costs a recording. */
export function assertWritable(file: string, force: boolean): void {
  if (!force && existsSync(file)) {
    throw new RecordError(
      'scenario-exists',
      `${file} already exists: pass --force to overwrite it`,
    );
  }
}

/**
 * Validates and writes the scenario. Without `force` the write itself refuses
 * an existing file (`wx`), so a file created during the session is kept too.
 */
export async function saveScenario(
  file: string,
  scenario: ScenarioInput,
  force: boolean,
): Promise<Issue[]> {
  const parsed = parseScenario(scenario);
  if (!parsed.ok) {
    throw new RecordError(
      'invalid-recording',
      'the recording is not a valid scenario; nothing was written',
      parsed.errors,
    );
  }
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(scenario, null, 2)}\n`, {
      flag: force ? 'w' : 'wx',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new RecordError(
        'scenario-exists',
        `${file} already exists: pass --force to overwrite it`,
      );
    }
    throw error;
  }
  return parsed.warnings;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
