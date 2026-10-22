import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseScenario } from '@demoflow/core';
import {
  createCaptureObserver,
  type EngineObserver,
  runScenario,
} from '@demoflow/engine';
import { startFixtureServer } from '../../../engine/test/execute/fixture-server.ts';
import { resolveFfmpeg } from '../../src/plan/ffmpeg.ts';

/**
 * Real runs for the renderer tests — shared, read-only. Needs Playwright's Chromium (as the engine's tests do)
 * and the built fixture, which turbo builds before `test`.
 */

/** The fixture scenarios in `apps/fixture/demoflow/`. */
export type FixtureScenario =
  | 'customers'
  | 'login'
  | 'tour'
  | 'failing'
  | 'masked-elements';

/** The password `login` types; a run never writes it to a file. */
export const FIXTURE_PASSWORD = 'correct-horse-battery';

/** Whether an FFmpeg is usable; tests that decode or encode video skip without one. */
export const hasFfmpeg: boolean = (() => {
  try {
    resolveFfmpeg();
    return true;
  } catch {
    return false;
  }
})();

const FIXTURE_ROOT = path.dirname(
  createRequire(import.meta.url).resolve('@demoflow/fixture/package.json'),
);

/**
 * Records `scenario` through the engine into `<parentDir>/<scenario>`, against
 * the fixture served on an ephemeral port, and returns that run directory. It
 * holds `source.webm`, `timeline.json` and `result.json`, as a CLI run does.
 * `observers` run before the capture observer.
 */
export async function recordFixtureRun(
  scenario: FixtureScenario,
  parentDir: string,
  observers: readonly EngineObserver[] = [],
): Promise<string> {
  const file = path.join(FIXTURE_ROOT, 'demoflow', `${scenario}.demo.json`);
  return recordInlineRun(
    scenario,
    JSON.parse(await readFile(file, 'utf8')),
    parentDir,
    observers,
  );
}

/**
 * Records a scenario given inline — validated as a scenario file is — against
 * the fixture, into `<parentDir>/<name>`, and returns that run directory.
 */
export async function recordInlineRun(
  name: string,
  input: unknown,
  parentDir: string,
  observers: readonly EngineObserver[] = [],
): Promise<string> {
  const parsed = parseScenario(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

  const runDir = path.join(parentDir, name);
  const fixture = await startFixtureServer();
  try {
    await runScenario(parsed.value, {
      runDir,
      baseUrl: fixture.origin,
      allowedOrigins: [fixture.origin],
      env: { FIXTURE_PASSWORD },
      observers: [
        ...observers,
        createCaptureObserver({ scenarioId: `demoflow/${name}.demo.json` }),
      ],
    });
  } finally {
    await fixture.close();
  }
  return runDir;
}
