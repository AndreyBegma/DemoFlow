import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseScenario,
  RunResultSchema,
  type Scenario,
  TimelineSchema,
} from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCaptureObserver,
  type EngineObserver,
  type RunOutcome,
  runScenario,
} from '../../src/index.ts';
import {
  FIXTURE_DIST,
  type FixtureServer,
  startFixtureServer,
} from '../execute/fixture-server.ts';

const SCENARIO_DIR = path.join(FIXTURE_DIST, '..', 'demoflow');
const PASSWORD = 'hunter2-correct-horse';

let fixture: FixtureServer;
const runDirs: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.close();
  await Promise.all(
    runDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function loadScenario(file: string): Promise<Scenario> {
  const raw = await readFile(path.join(SCENARIO_DIR, file), 'utf8');
  const parsed = parseScenario(JSON.parse(raw));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

interface Run {
  runDir: string;
  outcome: RunOutcome;
}

async function record(
  scenario: Scenario,
  scenarioId: string,
  extra: {
    env?: Record<string, string | undefined>;
    observers?: readonly EngineObserver[];
    runId?: string;
  } = {},
): Promise<Run> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-capture-'));
  runDirs.push(runDir);
  const outcome = await runScenario(scenario, {
    runDir,
    baseUrl: fixture.origin,
    allowedOrigins: [fixture.origin],
    env: extra.env ?? {},
    observers: [
      ...(extra.observers ?? []),
      createCaptureObserver({ scenarioId, runId: extra.runId }),
    ],
  });
  return { runDir, outcome };
}

async function readJson(runDir: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(runDir, file), 'utf8'));
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('customers.demo.json', () => {
  let run: Run;

  beforeAll(async () => {
    run = await record(
      await loadScenario('customers.demo.json'),
      'demoflow/customers.demo.json',
      { runId: '20260101-000000-abcdef' },
    );
  });

  it('writes the run directory layout', async () => {
    const names = (await readdir(run.runDir)).sort();
    expect(names).toEqual([
      'result.json',
      'scenario.json',
      'source.webm',
      'timeline.json',
    ]);
    expect(
      (await stat(path.join(run.runDir, 'source.webm'))).size,
    ).toBeGreaterThan(0);
  });

  it('writes a webm that starts with the EBML header', async () => {
    const head = await readFile(path.join(run.runDir, 'source.webm'));
    expect([...head.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  it('writes a timeline valid against core', async () => {
    const timeline = TimelineSchema.parse(
      await readJson(run.runDir, 'timeline.json'),
    );
    expect(timeline.videoFile).toBe('source.webm');
    expect(timeline.viewport).toEqual({ width: 1280, height: 720 });
    expect(timeline.deviceScaleFactor).toBe(2);
    expect(timeline.events).toHaveLength(11);
    expect(timeline.events).toEqual(run.outcome.events);
  });

  it('writes a result with rendering pending', async () => {
    const result = RunResultSchema.parse(
      await readJson(run.runDir, 'result.json'),
    );
    expect(result.runId).toBe('20260101-000000-abcdef');
    expect(result.scenarioId).toBe('demoflow/customers.demo.json');
    expect(result.scenarioName).toBe('Create a customer');
    expect(result.status).toBe('running');
    expect(result.stages.execution.status).toBe('passed');
    expect(result.stages.verification.status).toBe('passed');
    expect(result.stages.recording.status).toBe('passed');
    expect(result.stages.rendering.status).toBe('pending');
    expect(result.renders).toEqual([]);
  });

  it('keeps the validated scenario in scenario.json', async () => {
    const saved = await readJson(run.runDir, 'scenario.json');
    expect(parseScenario(saved).ok).toBe(true);
  });
});

describe('login.demo.json', () => {
  it('masks the password in the timeline and leaves it in no file', async () => {
    const { runDir } = await record(
      await loadScenario('login.demo.json'),
      'demoflow/login.demo.json',
      { env: { FIXTURE_PASSWORD: PASSWORD } },
    );

    const timeline = TimelineSchema.parse(
      await readJson(runDir, 'timeline.json'),
    );
    const fills = timeline.events.filter((event) => event.action === 'fill');
    const password = fills[1];
    expect(password.value).toBe('***');
    expect(password.masked).toBe(true);
    expect(fills[0].masked).toBeUndefined();

    const needle = Buffer.from(PASSWORD);
    const files = await filesIn(runDir);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      expect(
        (await readFile(file)).includes(needle),
        `${path.basename(file)} contains the password`,
      ).toBe(false);
    }
    // The scenario keeps the reference, not the value.
    const saved = await readFile(path.join(runDir, 'scenario.json'), 'utf8');
    expect(saved).toContain('FIXTURE_PASSWORD');
  });

  it('fails readiness without the variable and writes only the result', async () => {
    const { runDir, outcome } = await record(
      await loadScenario('login.demo.json'),
      'demoflow/login.demo.json',
    );
    expect(outcome.stages.readiness.status).toBe('failed');
    expect(outcome.stages.readiness.error?.message).toBe(
      'missing-env FIXTURE_PASSWORD',
    );
    expect((await readdir(runDir)).sort()).toEqual([
      'result.json',
      'scenario.json',
    ]);
    const result = RunResultSchema.parse(await readJson(runDir, 'result.json'));
    expect(result.status).toBe('failed');
  });
});

describe('failing.demo.json', () => {
  it('fails verification at the step, keeps the video, drops later steps', async () => {
    const { runDir, outcome } = await record(
      await loadScenario('failing.demo.json'),
      'demoflow/failing.demo.json',
    );
    const result = RunResultSchema.parse(await readJson(runDir, 'result.json'));
    expect(result.status).toBe('failed');
    expect(result.stages.verification.status).toBe('failed');
    expect(result.stages.verification.error?.stepIndex).toBe(2);
    expect(result.stages.verification.error?.message).toBeTruthy();
    expect(result.stages.execution.status).toBe('skipped');
    expect(result.stages.recording.status).toBe('passed');

    const timeline = TimelineSchema.parse(
      await readJson(runDir, 'timeline.json'),
    );
    expect(timeline.events.map((event) => event.stepIndex)).toEqual([0, 1, 2]);
    expect(timeline.events[2].assertion?.passed).toBe(false);
    expect(outcome.events).toHaveLength(3);
    expect((await stat(path.join(runDir, 'source.webm'))).size).toBeGreaterThan(
      0,
    );
  });
});

describe('tour.demo.json', () => {
  it('shows the "Details" tooltip when the screenshot after the hover is taken', async () => {
    let visibleAtShot: boolean | undefined;
    let page: import('playwright').Page | undefined;
    const probe: EngineObserver = {
      onPageCreated: (event) => {
        page = event.page;
      },
      onScreenshot: async ({ name }) => {
        if (name === 'hover-tooltip') {
          visibleAtShot = await page
            ?.getByText('Details', { exact: true })
            .isVisible();
        }
        return undefined;
      },
    };
    const { runDir, outcome } = await record(
      await loadScenario('tour.demo.json'),
      'demoflow/tour.demo.json',
      { observers: [probe] },
    );

    expect(outcome.status).toBe('running');
    expect(visibleAtShot).toBe(true);

    const timeline = TimelineSchema.parse(
      await readJson(runDir, 'timeline.json'),
    );
    const shots = timeline.events.filter((event) => event.screenshot);
    expect(shots.map((event) => event.screenshot)).toEqual([
      'screenshots/hover-tooltip.png',
      'screenshots/report-ready.png',
    ]);
    const png = await readFile(
      path.join(runDir, 'screenshots', 'hover-tooltip.png'),
    );
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    // The hover event is the step right before the screenshot.
    expect(timeline.events[2].action).toBe('hover');
    expect(timeline.events[3].action).toBe('screenshot');
  });
});
