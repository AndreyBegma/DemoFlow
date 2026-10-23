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
import { INLINE_PAGES } from './harness/inline-pages.ts';
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
  { name: 'tour', file: 'tour.pw.ts', title: 'tour', matched: 14 },
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
  fixture = await startFixtureServer(INLINE_PAGES);
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

  it('covers the hand-written scenarios: 5/5, 11/11, 14/14', async () => {
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

  it("records tour's container scroll and caption (spec 209)", async () => {
    const descriptions = result(recorded, 'tour.pw.ts').annotations.map(
      (annotation) => annotation.description ?? '',
    );
    expect(descriptions.join('\n')).not.toContain(
      'not recorded: page.mouse.wheel',
    );
    const { parsed } = await recordedScenario(PROBES[2]);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.value.steps).toContainEqual(
      expect.objectContaining({
        action: 'scroll',
        to: 'bottom',
        within: { testId: 'log-panel' },
      }),
    );
    expect(parsed.value.steps).toContainEqual(
      expect.objectContaining({
        action: 'marker',
        title: 'Slow report',
        kind: 'caption',
      }),
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

// Spec 209: container scrolls, `scrollIntoViewIfNeeded` and the `demoflow`
// fixture, on the inline pages of test/harness/inline-pages.ts.
const SCROLLS = 'scrolls.pw.ts';
const HELPERS = 'helpers.pw.ts';
const HELPERS_FAILING = ['caption-empty.pw.ts', 'caption-long.pw.ts'];
const SCROLL_FIRST = 'scroll-first.pw.ts';

describe('spec 209 (DEMOFLOW_RECORD=1)', () => {
  let run: PlaywrightRun;
  let tree: Map<string, string>;

  beforeAll(async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    run = await runPlaywright({
      files: [SCROLLS, HELPERS, SCROLL_FIRST, ...HELPERS_FAILING],
      record: '1',
      baseURL: fixture.origin,
      password,
    });
    tree = await readTree(OUTPUT);
  });

  function testResult(file: string, title: string): ProbeResult {
    const found = run.results.find(
      (each) => each.file.endsWith(file) && each.title === title,
    );
    if (found === undefined) {
      throw new Error(`${file} › ${title} did not run:\n${run.output}`);
    }
    return found;
  }

  /** The steps `<file> › <title>` recorded; it must have passed. */
  function stepsOf(file: string, title: string): unknown[] {
    expect(testResult(file, title).status, title).toBe('passed');
    const at = written(file, title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const text = tree.get(at);
    if (text === undefined) {
      throw new Error(`${at} not written; written: ${[...tree.keys()]}`);
    }
    return (JSON.parse(text) as { steps: unknown[] }).steps;
  }

  /**
   * The `not recorded:` reports of a test, once each: the JSON report can
   * carry an annotation on both the test and its result.
   */
  function reported(file: string, title: string): string[] {
    const descriptions = testResult(file, title)
      .annotations.map((annotation) => annotation.description ?? '')
      .filter((description) => description.startsWith('not recorded:'));
    return [...new Set(descriptions)];
  }

  it('records an id-only container as within {css: "#<id>"}', () => {
    expect(stepsOf(SCROLLS, 'id-only container')).toContainEqual({
      action: 'scroll',
      to: 'bottom',
      within: { css: '#by-id' },
    });
  });

  it('reports a container with neither data-testid nor id', async () => {
    const title = 'container without testid or id';
    expect(
      stepsOf(SCROLLS, title).some(
        (step) => (step as { action: string }).action === 'scroll',
      ),
    ).toBe(false);
    // The wheel is on the line after the hover that aims it.
    const line = (await lineOf(SCROLLS, "locator('.anonymous')")) + 1;
    expect(reported(SCROLLS, title)).toEqual([
      `not recorded: page.mouse.wheel at test/playwright/scrolls.pw.ts:${line}: the scroll container has no data-testid or id`,
    ]);
  });

  it('reports a wheel that ends mid-container', async () => {
    const title = 'mid-container';
    const line = await lineOf(SCROLLS, 'page.mouse.wheel(0, 100)');
    expect(
      stepsOf(SCROLLS, title).some(
        (step) => (step as { action: string }).action === 'scroll',
      ),
    ).toBe(false);
    expect(reported(SCROLLS, title)).toEqual([
      `not recorded: page.mouse.wheel at test/playwright/scrolls.pw.ts:${line}: the scroll ends mid-container`,
    ]);
  });

  it('records a wheel back up as to: "top"', () => {
    const scrolls = stepsOf(SCROLLS, 'back to the top').filter(
      (step) => (step as { action: string }).action === 'scroll',
    );
    expect(scrolls).toEqual([
      { action: 'scroll', to: 'bottom', within: { css: '#by-id' } },
      { action: 'scroll', to: 'top', within: { css: '#by-id' } },
    ]);
  });

  it('records a wheel over a non-scrollable box as a page scroll', () => {
    expect(stepsOf(SCROLLS, 'page scroll')).toContainEqual({
      action: 'scroll',
      to: 'bottom',
    });
    expect(reported(SCROLLS, 'page scroll')).toEqual([]);
  });

  it('records scrollIntoViewIfNeeded as scroll {target}', () => {
    expect(stepsOf(SCROLLS, 'scroll into view')).toEqual([
      { action: 'navigate', path: '/inline/scrolls' },
      { action: 'scroll', target: { testId: 'x' } },
    ]);
  });

  it('fails scrollIntoViewIfNeeded on .first() with its line', async () => {
    const line = await lineOf(SCROLL_FIRST, '.first()');
    const message = result(run, SCROLL_FIRST).errors.join('\n');
    expect(result(run, SCROLL_FIRST).status).toBe('failed');
    expect(message).toContain(
      `cannot record locator.scrollIntoViewIfNeeded at test/playwright/${SCROLL_FIRST}:${line}`,
    );
  });

  it('records demoflow.scene in call order', () => {
    expect(stepsOf(HELPERS, 'scene')).toEqual([
      { action: 'navigate', path: '/inline/buttons' },
      {
        action: 'click',
        target: { role: 'button', name: 'Add to cart' },
      },
      { action: 'marker', title: 'Checkout', kind: 'scene' },
      { action: 'click', target: { role: 'button', name: 'Checkout' } },
    ]);
  });

  it('fails an empty or a 121-character caption with its line, caught or not', async () => {
    for (const file of HELPERS_FAILING) {
      const line = await lineOf(file, 'demoflow.caption(');
      expect(result(run, file).status, file).toBe('failed');
      expect(result(run, file).errors.join('\n'), file).toContain(
        `demoflow.caption: expected 1–120 characters at test/playwright/${file}:${line}`,
      );
    }
  });

  it('writes no scenario for the failing tests', () => {
    const failing = [SCROLL_FIRST, ...HELPERS_FAILING].map(
      (file) =>
        `playwright/${file.replace(/\.ts$/, '').replace(/[^a-z0-9]+/g, '-')}/`,
    );
    for (const file of tree.keys()) {
      expect(
        failing.some((dir) => file.startsWith(dir)),
        file,
      ).toBe(false);
    }
  });
});

const PASSING_THROUGH = [
  ...PROBES.map((probe) => probe.file),
  'passthrough.pw.ts',
  HELPERS,
  ...HELPERS_FAILING,
];

describe.each([
  ['unset', undefined],
  ['0', '0'],
] as const)('pass-through (DEMOFLOW_RECORD %s)', (_label, record) => {
  let run: PlaywrightRun;

  beforeAll(async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    run = await runPlaywright({
      files: PASSING_THROUGH,
      record,
      baseURL: fixture.origin,
      password,
    });
  });

  it('passes the probes and the helper calls, with the real page and expect', () => {
    expect(run.code, run.output).toBe(0);
    for (const file of PASSING_THROUGH) {
      expect(result(run, file).status, file).toBe('passed');
    }
  });

  it('creates no demoflow/ directory', async () => {
    await expect(stat(OUTPUT)).rejects.toThrow();
  });
});
