import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseScenario, type Scenario } from '@demoflow/core';
import { runScenario } from '@demoflow/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coverage } from './harness/compare.ts';
import {
  FIXTURE_DIST,
  type FixtureServer,
  startFixtureServer,
} from './harness/fixture-server.ts';
import {
  lineOf,
  OUTPUT,
  PACKAGE,
  type PlaywrightRun,
  type ProbeResult,
  readTree,
  runPlaywright,
} from './harness/playwright.ts';

// Spec 208's acceptance criteria, end to end: Playwright Test runs the probes
// in test/playwright/ with the fixture, and this suite reads what it wrote.

const PROBES = [
  { name: 'login', file: 'login.pw.ts', title: 'sign in', matched: 5 },
  {
    name: 'customers',
    file: 'customers.pw.ts',
    title: 'create a customer',
    matched: 11,
  },
  { name: 'tour', file: 'tour.pw.ts', title: 'tour', matched: 12 },
] as const;
const FAILING = ['literal.pw.ts', 'row-first.pw.ts', 'keyboard.pw.ts'];

/** Where a probe's scenario is written, relative to `demoflow/`. */
const written = (file: string, title: string): string =>
  `playwright/${file.replace(/\.ts$/, '').replace(/[^a-z0-9]+/g, '-')}/${title.replaceAll(' ', '-')}.demo.json`;

const password = randomBytes(18).toString('hex');
let fixture: FixtureServer;
let recorded: PlaywrightRun;
let first: Map<string, string>;
let second: Map<string, string>;
const runDirs: string[] = [];

function result(run: PlaywrightRun, file: string): ProbeResult {
  const found = run.results.find((each) => each.file.endsWith(file));
  if (found === undefined)
    throw new Error(`${file} did not run:\n${run.output}`);
  return found;
}

beforeAll(async () => {
  fixture = await startFixtureServer();
  await rm(OUTPUT, { recursive: true, force: true });
  const files = [...PROBES.map((probe) => probe.file), ...FAILING];
  const run = (record: string | undefined) =>
    runPlaywright({ files, record, baseURL: fixture.origin, password });
  recorded = await run('1');
  first = await readTree(OUTPUT);
  recorded = await run('1');
  second = await readTree(OUTPUT);
});

afterAll(async () => {
  await fixture?.close();
  await rm(OUTPUT, { recursive: true, force: true });
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function recordedScenario(probe: (typeof PROBES)[number]) {
  const text = first.get(written(probe.file, probe.title));
  if (text === undefined) {
    throw new Error(
      `${probe.name} wrote nothing; written: ${[...first.keys()].join(', ')}\n${recorded.output}`,
    );
  }
  return { text, parsed: parseScenario(JSON.parse(text)) };
}

async function handWritten(name: string): Promise<Scenario> {
  const file = path.join(FIXTURE_DIST, '..', 'demoflow', `${name}.demo.json`);
  const parsed = parseScenario(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.ok) throw new Error(`${file} is invalid`);
  return parsed.value;
}

describe('recording (DEMOFLOW_RECORD=1)', () => {
  it('passes the probes and fails the three that cannot be recorded', () => {
    for (const probe of PROBES) {
      expect(result(recorded, probe.file).status, probe.name).toBe('passed');
    }
    for (const file of FAILING) {
      expect(result(recorded, file).status, file).toBe('failed');
    }
  });

  it('writes the committed expected files, and only the probes', async () => {
    expect([...first.keys()].sort()).toEqual(
      PROBES.map((probe) => written(probe.file, probe.title)).sort(),
    );
    for (const probe of PROBES) {
      const expected = await readFile(
        path.join(PACKAGE, 'test', 'expected', `${probe.name}.demo.json`),
        'utf8',
      );
      const { text } = await recordedScenario(probe);
      // A Windows checkout may give the committed file CRLF line endings.
      expect(text, probe.name).toBe(expected.replaceAll('\r\n', '\n'));
    }
  });

  it('records twice to the same bytes', () => {
    expect(second).toEqual(first);
  });

  it('covers the hand-written scenarios: 5/5, 11/11, 12/14', async () => {
    for (const probe of PROBES) {
      const { parsed } = await recordedScenario(probe);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const expected = (await handWritten(probe.name)).steps;
      const measured = coverage(expected, parsed.value.steps);
      expect(measured.matched, probe.name).toBe(probe.matched);
    }
  });

  it('records the password as its variable and writes it nowhere', async () => {
    const { parsed } = await recordedScenario(PROBES[0]);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.value.steps).toContainEqual(
      expect.objectContaining({
        action: 'fill',
        target: { label: 'Password' },
        valueFrom: { env: 'FIXTURE_PASSWORD' },
      }),
    );
    for (const [file, text] of first) {
      expect(text.includes(password), file).toBe(false);
    }
    for (const each of recorded.results) {
      expect(JSON.stringify(each.annotations).includes(password)).toBe(false);
    }
  });

  it('refuses a literal password with its line, and writes no scenario', async () => {
    const line = await lineOf('literal.pw.ts', ".fill('literal-password-1')");
    const { errors } = result(recorded, 'literal.pw.ts');
    expect(errors.join('\n')).toContain(
      `refusing to record a password at test/playwright/literal.pw.ts:${line}`,
    );
    expect(errors.join('\n')).not.toContain('literal-password-1');
  });

  it('fails a chained locator and raw keyboard input with their lines', async () => {
    for (const [file, text] of [
      ['row-first.pw.ts', '.first().click()'],
      ['keyboard.pw.ts', 'page.keyboard.type'],
    ] as const) {
      const line = await lineOf(file, text);
      const message = result(recorded, file).errors.join('\n');
      expect(message, file).toMatch(/demoflow: cannot record/);
      expect(message, file).toContain(`at test/playwright/${file}:${line}`);
    }
  });

  it("reports tour's container scroll as an annotation", async () => {
    const line = await lineOf('tour.pw.ts', 'page.mouse.wheel');
    const descriptions = result(recorded, 'tour.pw.ts').annotations.map(
      (annotation) => annotation.description ?? '',
    );
    expect(descriptions).toContainEqual(
      expect.stringContaining(
        `not recorded: page.mouse.wheel at test/playwright/tour.pw.ts:${line}`,
      ),
    );
  });

  it('writes scenarios the engine replays, at demo pace', async () => {
    for (const probe of PROBES) {
      const { parsed } = await recordedScenario(probe);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const runDir = await mkdtemp(path.join(tmpdir(), `demoflow-pw-replay-`));
      runDirs.push(runDir);
      const outcome = await runScenario(parsed.value, {
        runDir,
        baseUrl: fixture.origin,
        allowedOrigins: [fixture.origin],
        env: { FIXTURE_PASSWORD: password },
      });
      expect(outcome.stages.execution.status, probe.name).toBe('passed');
      expect(outcome.stages.recording.status, probe.name).toBe('passed');
      if (probe.name === 'login') {
        const span = outcome.events.at(-1)!.endMs - outcome.events[0]!.startMs;
        expect(span).toBeGreaterThanOrEqual(2_000);
      }
    }
  });
});

describe.each([
  ['unset', undefined],
  ['0', '0'],
] as const)('pass-through (DEMOFLOW_RECORD %s)', (_label, record) => {
  let run: PlaywrightRun;

  beforeAll(async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    run = await runPlaywright({
      files: [...PROBES.map((probe) => probe.file), 'passthrough.pw.ts'],
      record,
      baseURL: fixture.origin,
      password,
    });
  });

  it('passes the probes, with the real page and expect', () => {
    expect(run.code, run.output).toBe(0);
    for (const file of [...PROBES.map((p) => p.file), 'passthrough.pw.ts']) {
      expect(result(run, file).status, file).toBe('passed');
    }
  });

  it('creates no demoflow/ directory', async () => {
    await expect(stat(OUTPUT)).rejects.toThrow();
  });
});
