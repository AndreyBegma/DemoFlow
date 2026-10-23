import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Spawns Playwright Test on the probes: `node <@playwright/test>/cli.js test`,
// no shell, no `npx` and no `.cmd` shim, so the same call works on Linux,
// macOS and Windows. Results come back from the JSON reporter.

/** packages/playwright, where playwright.config.ts lives. */
export const PACKAGE = path.resolve(import.meta.dirname, '..', '..');
/** Where the fixture writes scenarios: `<configDir>/demoflow/`. */
export const OUTPUT = path.join(PACKAGE, 'demoflow');
export const PROBE_DIR = path.join(PACKAGE, 'test', 'playwright');

export interface ProbeResult {
  /** The test file, relative to the probe directory. */
  file: string;
  title: string;
  status: string;
  errors: string[];
  annotations: { type: string; description?: string }[];
}

export interface PlaywrightRun {
  code: number | null;
  results: ProbeResult[];
  output: string;
}

export interface RunInput {
  files: readonly string[];
  /** `'1'`, another value, or `undefined` to leave DEMOFLOW_RECORD unset. */
  record: string | undefined;
  baseURL: string;
  password: string;
  /** An npm alias of @playwright/test; the pinned one by default. */
  playwrightPackage?: string;
}

const require = createRequire(import.meta.url);

export async function runPlaywright(input: RunInput): Promise<PlaywrightRun> {
  const name = input.playwrightPackage ?? '@playwright/test';
  const cli = path.join(
    path.dirname(require.resolve(`${name}/package.json`)),
    'cli.js',
  );
  const work = await mkdtemp(path.join(tmpdir(), 'demoflow-pw-'));
  const report = path.join(work, 'report.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_PASSWORD: input.password,
    DEMOFLOW_PW_BASE_URL: input.baseURL,
    DEMOFLOW_PW_REPORT: report,
    DEMOFLOW_PW_OUTPUT: path.join(work, 'results'),
  };
  delete env.DEMOFLOW_RECORD;
  delete env.DEMOFLOW_PLAYWRIGHT_PACKAGE;
  if (input.record !== undefined) env.DEMOFLOW_RECORD = input.record;
  if (input.playwrightPackage !== undefined) {
    env.DEMOFLOW_PLAYWRIGHT_PACKAGE = input.playwrightPackage;
  }
  try {
    const { code, output } = await new Promise<{
      code: number | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cli, 'test', ...input.files.map((file) => `test/playwright/${file}`)],
        { cwd: PACKAGE, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('close', (exit) => resolve({ code: exit, output }));
    });
    const results = await readReport(report).catch((error: unknown) => {
      throw new Error(`no Playwright report (${String(error)}):\n${output}`);
    });
    return { code, results, output };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: {
    title: string;
    file: string;
    tests: {
      annotations?: { type: string; description?: string }[];
      results: {
        status: string;
        errors?: { message?: string }[];
        annotations?: { type: string; description?: string }[];
      }[];
    }[];
  }[];
}

async function readReport(file: string): Promise<ProbeResult[]> {
  const report = JSON.parse(await readFile(file, 'utf8')) as {
    suites: JsonSuite[];
  };
  const results: ProbeResult[] = [];
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        results.push({
          file: spec.file.replaceAll('\\', '/'),
          title: spec.title,
          status: last?.status ?? 'none',
          errors: (last?.errors ?? []).map((error) => error.message ?? ''),
          annotations: [
            ...(test.annotations ?? []),
            ...(last?.annotations ?? []),
          ],
        });
      }
    }
    for (const inner of suite.suites ?? []) visit(inner);
  };
  for (const suite of report.suites) visit(suite);
  return results;
}

/** Every file under `dir`, relative and `/`-separated, with its bytes. */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(
      path.relative(dir, full).replaceAll('\\', '/'),
      await readFile(full, 'utf8'),
    );
  }
  return files;
}

/** The 1-based line of the first line of `file` that contains `text`. */
export async function lineOf(file: string, text: string): Promise<number> {
  const lines = (await readFile(path.join(PROBE_DIR, file), 'utf8')).split(
    /\r?\n/,
  );
  const index = lines.findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`${file} has no line with ${text}`);
  return index + 1;
}
