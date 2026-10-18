import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Io } from '../../src/commands/io.ts';
import {
  type RecordDeps,
  type RecordFlags,
  recordCommand,
} from '../../src/record/command.ts';
import type { RecordSession } from '../../src/record/session.ts';

/**
 * Headed wherever there is a display: macOS, Windows, and Linux under X or
 * Wayland (CI runs these under `xvfb-run`). Linux without one runs the same
 * session headless — only the launch flag differs (spec #79, Q2).
 */
export const HEADLESS =
  process.platform === 'linux' &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY;

// The CI job that exists to prove the headed path must not pass headless.
if (HEADLESS && process.env.DEMOFLOW_RECORD_HEADED === '1') {
  throw new Error(
    'DEMOFLOW_RECORD_HEADED=1 but there is no display: run under xvfb-run',
  );
}

export interface Recorded {
  code: number;
  stdout: string;
  stderr: string;
}

/** A project directory whose config points at `baseUrl`. */
export async function makeProject(
  baseUrl: string,
  extra: object = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'demoflow-record-'));
  await writeFile(
    path.join(root, 'demoflow.config.json'),
    JSON.stringify({ baseUrl, ...extra }),
  );
  return root;
}

/**
 * Runs `demoflow record` in-process; `drive` uses the two windows as a person
 * would and ends the session (usually with `stopAndSave`).
 */
export async function record(
  root: string,
  name: string | undefined,
  flags: RecordFlags,
  drive: (session: RecordSession) => Promise<void>,
  deps: Partial<RecordDeps> = {},
): Promise<Recorded> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await recordCommand(name, { run: false, ...flags }, io, {
    cwd: root,
    headless: HEADLESS,
    onSession: drive,
    confirmRun: async () => false,
    run: async () => 0,
    ...deps,
  });
  return { code, stdout, stderr };
}

/** Waits until the panel lists a step whose summary contains `text`. */
export async function panelShows(panel: Page, text: string): Promise<void> {
  await panel
    .locator('#steps li .summary', { hasText: text })
    .first()
    .waitFor({ timeout: 10_000 });
}

export async function panelButton(panel: Page, name: string): Promise<void> {
  await panel.getByRole('button', { name, exact: true }).click();
}

export async function stopAndSave(session: RecordSession): Promise<void> {
  await panelButton(session.panel, 'Stop and save');
}
