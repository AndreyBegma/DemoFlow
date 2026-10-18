import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { AppStartError, startApp } from '../app/dev-server.ts';
import { type BrowserDeps, ensureChromium } from '../commands/browser.ts';
import { EXIT_STAGE_FAILED } from '../commands/errors.ts';
import type { Io } from '../commands/io.ts';
import { runCommand } from '../commands/run.ts';
import {
  CliError,
  findProjectRoot,
  loadProjectConfig,
  PROJECT_CONFIG_FILE,
  projectRootAt,
} from '../config/index.ts';
import {
  assertWritable,
  parseViewport,
  RecordError,
  saveScenario,
  scenarioPath,
} from './save.ts';
import { openRecorder, type RecordSession } from './session.ts';
import { buildScenario } from './steps.ts';

export const DEFAULT_NAME = 'recording';
export const DEFAULT_VIEWPORT = '1280x720';

export interface RecordFlags {
  force?: boolean;
  /** `--no-run` sets this to false. */
  run?: boolean;
  viewport?: string;
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface RecordDeps {
  cwd: string;
  headless: boolean;
  browser?: BrowserDeps;
  /** Called once the windows are open; tests drive the session from here. */
  onSession?: (session: RecordSession) => void | Promise<void>;
  /** Asks whether to run the new scenario; `false` when nobody can answer. */
  confirmRun: () => Promise<boolean>;
  /** `demoflow run <file>`. */
  run: (file: string, root: string, io: Io) => Promise<number>;
}

export function defaultRecordDeps(): RecordDeps {
  return {
    cwd: process.cwd(),
    headless: false,
    confirmRun: askOnTerminal,
    run: (file, root, io) => runCommand(file, { project: root }, io),
  };
}

/**
 * `demoflow record [name]` (spec #79): start the app, record in a headed
 * browser with a step panel, write `demoflow/<name>.demo.json`, offer a run.
 * Config errors are thrown (exit 2, like `run`); the command's own problems
 * are reported here.
 */
export async function recordCommand(
  name: string | undefined,
  flags: RecordFlags,
  io: Io,
  deps: RecordDeps = defaultRecordDeps(),
): Promise<number> {
  const root =
    flags.project === undefined
      ? projectRootAbove(deps.cwd)
      : projectRootAt(path.resolve(deps.cwd, flags.project));
  const config = loadProjectConfig(root);
  const force = flags.force === true;
  const scenarioName = name ?? DEFAULT_NAME;
  let file: string;
  let viewport: ReturnType<typeof parseViewport>;
  try {
    viewport = parseViewport(flags.viewport ?? DEFAULT_VIEWPORT);
    file = scenarioPath(root, scenarioName);
    assertWritable(file, force);
  } catch (error) {
    return reportRecordError(error, io);
  }

  if ((await ensureChromium(io, deps.browser)) === 'failed') {
    return EXIT_STAGE_FAILED;
  }
  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    app = await startApp(config, root, { log: (text) => io.stderr(text) });
  } catch (error) {
    if (!(error instanceof AppStartError)) throw error;
    io.stderr(`app-not-ready: ${error.message}\n`);
    return EXIT_STAGE_FAILED;
  }

  let steps: Awaited<RecordSession['done']>;
  const browser = await chromium.launch({ headless: deps.headless });
  let interrupt = (): void => {};
  try {
    const session = await openRecorder(browser, {
      baseUrl: config.baseUrl,
      allowedOrigins: config.allowedOrigins,
      viewport,
    });
    interrupt = () => session.stop();
    process.on('SIGINT', interrupt);
    io.stderr(
      'Recording: use the app window; the panel window adds scenes, captions, waits and checks. Stop and save from the panel.\n',
    );
    await deps.onSession?.(session);
    steps = await session.done;
  } finally {
    process.off('SIGINT', interrupt);
    await browser.close().catch(() => {});
    await app.stop();
  }

  let warnings: Awaited<ReturnType<typeof saveScenario>>;
  try {
    if (steps.length === 0) {
      throw new RecordError(
        'nothing-recorded',
        'no steps were recorded; nothing was written',
      );
    }
    warnings = await saveScenario(
      file,
      buildScenario(scenarioName, viewport, steps),
      force,
    );
  } catch (error) {
    return reportRecordError(error, io);
  }
  for (const warning of warnings) {
    io.stderr(`warning ${warning.path}: ${warning.message}\n`);
  }
  io.stdout(`${file}\n`);

  if (flags.run === false) return 0;
  if (!(await deps.confirmRun())) {
    io.stderr(
      `Run it with: demoflow run ${path.relative(deps.cwd, file) || file}\n`,
    );
    return 0;
  }
  return deps.run(file, root, io);
}

/** The project holding `dir`, searched upwards as for a scenario file. */
function projectRootAbove(dir: string): string {
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

function reportRecordError(error: unknown, io: Io): number {
  if (!(error instanceof RecordError)) throw error;
  const lines = [`${error.code}: ${error.message}`];
  for (const issue of error.issues) {
    lines.push(
      `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`,
    );
  }
  io.stderr(`${lines.join('\n')}\n`);
  return error.exitCode;
}

/** A yes/no on the terminal; no terminal, no question. */
async function askOnTerminal(): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question('Run it now? [Y/n] ');
    return /^(y|yes|)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
