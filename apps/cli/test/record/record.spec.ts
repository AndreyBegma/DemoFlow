import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expandScenario, parseScenario } from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Read-only helper of the engine's tests: serves the built fixture on an ephemeral port.
import {
  type FixtureServer,
  startFixtureServer,
} from '../../../../packages/engine/test/execute/fixture-server.ts';
import { runCommand } from '../../src/commands/run.ts';
import { main } from '../../src/main.ts';
import { CSS_WARNING } from '../../src/record/locator.ts';
import {
  makeProject,
  panelButton,
  panelShows,
  record,
  stopAndSave,
} from './harness.ts';

/** A page with a click counter and an element only a css path can reach. */
const COUNTER_PAGE = `<!doctype html>
<html><head><title>Counter</title></head><body>
  <h1>Counter</h1>
  <button id="count" onclick="clicks.textContent = Number(clicks.textContent) + 1">Count</button>
  <output id="clicks">0</output>
  <input aria-label="Note"><input type="password" aria-label="Pin">
  <textarea aria-label="Body"></textarea>
  <div class="row"><span class="swatch" style="display:inline-block;width:40px;height:40px;background:teal" onclick="clicks.textContent = Number(clicks.textContent) + 1"></span></div>
</body></html>`;

let fixture: FixtureServer;
let counter: Server;
let counterOrigin: string;
const roots: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer();
  counter = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(COUNTER_PAGE);
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  counterOrigin = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await fixture?.close();
  await new Promise<void>((resolve) => counter?.close(() => resolve()));
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(baseUrl: string): Promise<string> {
  const root = await makeProject(baseUrl);
  roots.push(root);
  return root;
}

const scenarioFile = (root: string, name: string) =>
  path.join(root, 'demoflow', `${name}.demo.json`);

async function readScenario(root: string, name: string) {
  return JSON.parse(await readFile(scenarioFile(root, name), 'utf8')) as {
    name: string;
    viewport: { width: number; height: number };
    steps: Record<string, unknown>[];
  };
}

describe('demoflow record against the fixture', () => {
  it('records navigate, click, typing and a picked heading into a scenario that runs and passes', async () => {
    const root = await project(fixture.origin);
    const result = await record(root, 'customers', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      // A typed-in URL. The home page lists a second "Customers" link; the
      // login page has only the navigation's.
      await app.goto(`${fixture.origin}/login`);
      await panelShows(panel, 'navigate /login');
      await app.getByRole('link', { name: 'Customers' }).click();
      await panelShows(panel, 'click link "Customers"');
      await app
        .getByRole('searchbox', { name: 'Search customers' })
        .pressSequentially('Ada', { delay: 40 });
      await panelShows(panel, '= "Ada"');
      await panelButton(panel, 'Pick: text');
      await app.getByRole('heading', { name: 'Customers' }).click();
      await panelShows(panel, 'assert text heading "Customers"');
      await stopAndSave(session);
    });

    expect(result.stderr).not.toMatch(/no locator reaches/);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(scenarioFile(root, 'customers'));
    const scenario = await readScenario(root, 'customers');
    expect(scenario.name).toBe('customers');
    expect(scenario.viewport).toEqual({ width: 1280, height: 720 });
    expect(
      scenario.steps,
      `recorded steps: ${JSON.stringify(scenario.steps, null, 2)}`,
    ).toEqual([
      // The start and the typed URL fold into one navigation.
      { action: 'navigate', path: '/login' },
      { action: 'click', target: { role: 'link', name: 'Customers' } },
      {
        action: 'fill',
        target: { role: 'searchbox', name: 'Search customers' },
        value: 'Ada',
      },
      {
        action: 'assertText',
        target: { role: 'heading', name: 'Customers' },
        text: 'Customers',
      },
    ]);

    // `demoflow run` on the recorded file: verification passes.
    let stdout = '';
    const code = await runCommand(
      scenarioFile(root, 'customers'),
      { json: true, project: root, out: path.join(root, 'artifacts') },
      { stdout: (text) => (stdout += text), stderr: () => {} },
    );
    const run = JSON.parse(stdout) as {
      status: string;
      stages: { verification: { status: string } };
    };
    expect(run.stages.verification.status).toBe('passed');
    expect(code).toBe(0);
  });

  it('records the login password as valueFrom DEMO_PASSWORD and the typed text goes nowhere', async () => {
    const secret = 'hunter2-Sup3r-Secret';
    const root = await project(fixture.origin);
    const result = await record(root, 'login', {}, async (session) => {
      const { app, panel } = session;
      await app.goto(`${fixture.origin}/login`);
      await panelShows(panel, 'navigate /login');
      await app
        .getByLabel('Email')
        .pressSequentially('ada@example.com', { delay: 10 });
      await panelShows(panel, 'ada@example.com');
      await app.getByLabel('Password').pressSequentially(secret, { delay: 10 });
      await panelShows(panel, '← env DEMO_PASSWORD');
      const panelText = await panel.locator('body').innerText();
      expect(panelText).not.toContain(secret);
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const raw = await readFile(scenarioFile(root, 'login'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    const { steps } = JSON.parse(raw) as { steps: Record<string, unknown>[] };
    expect(steps).toContainEqual({
      action: 'fill',
      target: { label: 'Password' },
      valueFrom: { env: 'DEMO_PASSWORD' },
    });
  });
});

describe('demoflow record: Repeat over data', () => {
  it('wraps a ticked fill in a repeat over three lines, and the scenario validates and replays three times', async () => {
    const root = await project(fixture.origin);
    const result = await record(root, 'repeat', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      await app.goto(`${fixture.origin}/login`);
      await panelShows(panel, 'navigate /login');
      await app.getByRole('link', { name: 'Customers' }).click();
      await panelShows(panel, 'click link "Customers"');
      await app
        .getByRole('searchbox', { name: 'Search customers' })
        .pressSequentially('Ada', { delay: 40 });
      await panelShows(panel, '= "Ada"');
      // An assertion, so the replay verifies something.
      await panelButton(panel, 'Pick: text');
      await app.getByRole('heading', { name: 'Customers' }).click();
      await panelShows(panel, 'assert text heading "Customers"');

      await panel.getByRole('checkbox', { name: 'Select step 3' }).check();
      await panelButton(panel, 'Repeat over data');
      await panel.getByLabel('List name').fill('names');
      await panel.getByLabel('Values 1, one per line').fill('Ada\nGrace\nAlan');
      await panelButton(panel, 'Create repeat');
      await panelShows(panel, 'repeat over names (1 steps)');
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const scenario = await readScenario(root, 'repeat');
    expect(scenario).toMatchObject({
      data: { names: [{ text: 'Ada' }, { text: 'Grace' }, { text: 'Alan' }] },
    });
    expect(scenario.steps.slice(2, 3)).toEqual([
      {
        action: 'repeat',
        each: 'names',
        steps: [
          {
            action: 'fill',
            target: { role: 'searchbox', name: 'Search customers' },
            value: '{{item.text}}',
          },
        ],
      },
    ]);

    const parsed = parseScenario(scenario);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      expandScenario(parsed.value).steps.map((step) => step.action),
    ).toEqual(['navigate', 'click', 'fill', 'fill', 'fill', 'assertText']);

    let stdout = '';
    const code = await runCommand(
      scenarioFile(root, 'repeat'),
      { json: true, project: root, out: path.join(root, 'artifacts') },
      { stdout: (text) => (stdout += text), stderr: () => {} },
    );
    const run = JSON.parse(stdout) as {
      status: string;
      stages: { verification: { status: string } };
    };
    expect(run.stages.verification.status).toBe('passed');
    expect(code).toBe(0);
  });

  it('refuses a ticked run with gaps, and a selection with no typed text', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'gaps', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      await app.getByRole('button', { name: 'Count' }).click();
      await panelShows(panel, 'click button "Count"');
      await panel.getByRole('checkbox', { name: 'Select step 2' }).check();
      await panelButton(panel, 'Repeat over data');
      await panel
        .getByText('the ticked steps type no text to repeat over')
        .waitFor();
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const scenario = await readScenario(root, 'gaps');
    expect(scenario).not.toHaveProperty('data');
    expect(scenario.steps.map((step) => step.action)).toEqual([
      'navigate',
      'click',
    ]);
  });
});

describe('demoflow record: Wait for ready', () => {
  it('appends a waitForReady step for a valid name, clears the input, and the scenario validates', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'ready', {}, async (session) => {
      const { panel } = session;
      await panelShows(panel, 'navigate /');
      await panel.getByLabel('Ready name').fill(' dashboard-loaded ');
      await panelButton(panel, 'Wait for ready');
      await panelShows(panel, 'wait for ready dashboard-loaded');
      expect(await panel.getByLabel('Ready name').inputValue()).toBe('');
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const scenario = await readScenario(root, 'ready');
    expect(scenario.steps).toEqual([
      { action: 'navigate', path: '/' },
      { action: 'waitForReady', name: 'dashboard-loaded' },
    ]);
    expect(() => parseScenario(JSON.stringify(scenario))).not.toThrow();
  });

  it('adds no step for a name ReadyNameSchema rejects, and the notice names the rule', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'bad-ready', {}, async (session) => {
      const { panel } = session;
      await panelShows(panel, 'navigate /');
      await panel.getByLabel('Ready name').fill('9 bad name!');
      await panelButton(panel, 'Wait for ready');
      await panel
        .getByText(
          '"9 bad name!" is not a ready name: expected 1–64 characters',
        )
        .waitFor();
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const scenario = await readScenario(root, 'bad-ready');
    expect(scenario.steps).toEqual([{ action: 'navigate', path: '/' }]);
  });
});

describe('demoflow record on a test page', () => {
  it('in pick mode adds an assertion and the click never reaches the page', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'pick', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      await panelButton(panel, 'Pick: visible');
      await app.getByRole('button', { name: 'Count' }).click();
      await panelShows(panel, 'assert visible button "Count"');
      expect(await app.locator('#clicks').textContent()).toBe('0');
      // Back in record mode, a click reaches the page again.
      await app.getByRole('button', { name: 'Count' }).click();
      await panelShows(panel, 'click button "Count"');
      expect(await app.locator('#clicks').textContent()).toBe('1');
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const { steps } = await readScenario(root, 'pick');
    expect(steps.slice(1)).toEqual([
      { action: 'assertVisible', target: { role: 'button', name: 'Count' } },
      { action: 'click', target: { role: 'button', name: 'Count' } },
    ]);
  });

  it('turns Enter in a text field into a press step on that field', async () => {
    const root = await project(fixture.origin);
    const result = await record(root, 'press', {}, async (session) => {
      const { app, panel } = session;
      await app.goto(`${fixture.origin}/customers`);
      await panelShows(panel, 'navigate /customers');
      const search = app.getByRole('searchbox', { name: 'Search customers' });
      await search.pressSequentially('Ada', { delay: 40 });
      await panelShows(panel, '= "Ada"');
      await search.press('Enter');
      await panelShows(panel, 'press Enter on');
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const { steps } = await readScenario(root, 'press');
    expect(steps).toEqual([
      { action: 'navigate', path: '/customers' },
      {
        action: 'fill',
        target: { role: 'searchbox', name: 'Search customers' },
        value: 'Ada',
      },
      {
        action: 'press',
        key: 'Enter',
        target: { role: 'searchbox', name: 'Search customers' },
      },
    ]);
  });

  it('never records a key inside a password field, or Enter that only types a newline', async () => {
    const pin = '4821';
    const root = await project(counterOrigin);
    const result = await record(root, 'keys', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      const secret = app.getByLabel('Pin');
      await secret.pressSequentially(pin, { delay: 10 });
      await panelShows(panel, '← env DEMO_PASSWORD');
      await secret.press('Enter');
      await secret.press('Tab');
      await app.getByLabel('Body').press('Enter');
      // Queued in order: once this press shows, the ones before it were handled.
      await app.getByLabel('Note').press('Escape');
      await panelShows(panel, 'press Escape on');
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const raw = await readFile(scenarioFile(root, 'keys'), 'utf8');
    expect(raw).not.toContain(pin);
    const { steps } = JSON.parse(raw) as { steps: { action: string }[] };
    expect(steps.filter((step) => step.action === 'press')).toEqual([
      {
        action: 'press',
        key: 'Escape',
        target: { role: 'textbox', name: 'Note' },
      },
    ]);
  });

  it('falls back to css only when nothing else is unique, and the panel warns about it', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'css', {}, async (session) => {
      const { app, panel } = session;
      await panelShows(panel, 'navigate /');
      await app.locator('.swatch').click();
      await panelShows(panel, 'click css');
      const warning = panel.locator('#steps li .warning');
      expect(await warning.count()).toBe(1);
      expect(await warning.innerText()).toContain(CSS_WARNING);
      await stopAndSave(session);
    });

    expect(result.code).toBe(0);
    const { steps } = await readScenario(root, 'css');
    expect(steps).toHaveLength(2);
    const click = steps[1] as { action: string; target: { css?: string } };
    expect(click.action).toBe('click');
    expect(click.target.css).toBeTypeOf('string');
  });

  it('never overwrites an existing scenario without --force', async () => {
    const root = await project(counterOrigin);
    const file = scenarioFile(root, 'recording');
    await record(root, undefined, {}, async (session) => {
      await panelShows(session.panel, 'navigate /');
      await stopAndSave(session);
    });
    await writeFile(file, 'mine');

    let opened = false;
    const refused = await record(root, undefined, {}, async (session) => {
      opened = true;
      await stopAndSave(session);
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('scenario-exists');
    expect(opened).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('mine');

    const forced = await record(
      root,
      undefined,
      { force: true },
      async (session) => {
        await panelShows(session.panel, 'navigate /');
        await stopAndSave(session);
      },
    );
    expect(forced.code).toBe(0);
    expect((await readScenario(root, 'recording')).name).toBe('recording');
  });

  it('is wired into the program: an existing file stops it before any browser starts', async () => {
    const root = await project(counterOrigin);
    await mkdir(path.join(root, 'demoflow'));
    await writeFile(scenarioFile(root, 'taken'), 'mine');
    let stderr = '';
    const code = await main(['record', 'taken', '--project', root], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('scenario-exists');
    expect(await readFile(scenarioFile(root, 'taken'), 'utf8')).toBe('mine');
  });

  it('writes nothing when no step was recorded', async () => {
    const root = await project(counterOrigin);
    const result = await record(root, 'empty', {}, async (session) => {
      await panelShows(session.panel, 'navigate /');
      await session.panel
        .getByRole('button', { name: 'Delete step 1' })
        .click();
      await session.panel
        .locator('#steps li')
        .first()
        .waitFor({ state: 'detached' });
      await stopAndSave(session);
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('nothing-recorded');
    await expect(stat(scenarioFile(root, 'empty'))).rejects.toThrow();
  });
});
