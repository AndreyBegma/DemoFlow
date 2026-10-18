import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWritable,
  parseViewport,
  RecordError,
  saveScenario,
  scenarioPath,
} from '../../src/record/save.ts';
import {
  appendStep,
  buildScenario,
  moveStep,
  navigateStep,
  type RecordedStep,
  removeStep,
} from '../../src/record/steps.ts';

const search = { label: 'Search customers' };

describe('appendStep', () => {
  it('folds typing into one field into one fill', () => {
    let steps: RecordedStep[] = [];
    for (const value of ['A', 'Ad', 'Ada']) {
      steps = appendStep(steps, {
        step: { action: 'fill', target: search, value },
      });
    }
    expect(steps).toEqual([
      { step: { action: 'fill', target: search, value: 'Ada' } },
    ]);
  });

  it('keeps fills of different fields apart', () => {
    let steps: RecordedStep[] = [];
    steps = appendStep(steps, {
      step: { action: 'fill', target: { label: 'Name' }, value: 'Ada' },
    });
    steps = appendStep(steps, {
      step: { action: 'fill', target: { label: 'Email' }, value: 'a@b.c' },
    });
    expect(steps).toHaveLength(2);
  });

  it('folds a redirect into the navigation before it, and a scroll gesture into one scroll', () => {
    let steps: RecordedStep[] = [];
    steps = appendStep(steps, { step: { action: 'navigate', path: '/' } });
    steps = appendStep(steps, {
      step: { action: 'navigate', path: '/home' },
    });
    steps = appendStep(steps, { step: { action: 'scroll', to: 'bottom' } });
    steps = appendStep(steps, { step: { action: 'scroll', to: 'top' } });
    expect(steps.map(({ step }) => step)).toEqual([
      { action: 'navigate', path: '/home' },
      { action: 'scroll', to: 'top' },
    ]);
  });

  it('never folds two clicks', () => {
    const click: RecordedStep = {
      step: { action: 'click', target: { role: 'button', name: 'Add' } },
    };
    expect(appendStep(appendStep([], click), click)).toHaveLength(2);
  });
});

describe('navigateStep', () => {
  const base = 'http://localhost:3680';

  it('records a path on the base origin, with query and hash', () => {
    expect(navigateStep('http://localhost:3680/customers?q=a#x', base)).toEqual(
      { action: 'navigate', path: '/customers?q=a#x' },
    );
  });

  it('records the full url on another origin', () => {
    expect(navigateStep('https://example.com/a', base)).toEqual({
      action: 'navigate',
      url: 'https://example.com/a',
    });
  });

  it('ignores what is not http', () => {
    expect(navigateStep('about:blank', base)).toBeNull();
    expect(navigateStep('chrome-error://chromewebdata/', base)).toBeNull();
  });
});

describe('moveStep and removeStep', () => {
  const steps: RecordedStep[] = [1, 2, 3].map((ms) => ({
    step: { action: 'wait', ms },
  }));
  const order = (list: RecordedStep[]) =>
    list.map(({ step }) => (step.action === 'wait' ? step.ms : 0));

  it('moves up and down, and ignores moves past the ends', () => {
    expect(order(moveStep(steps, 2, -1))).toEqual([1, 3, 2]);
    expect(order(moveStep(steps, 0, 1))).toEqual([2, 1, 3]);
    expect(order(moveStep(steps, 0, -1))).toEqual([1, 2, 3]);
    expect(order(moveStep(steps, 2, 1))).toEqual([1, 2, 3]);
  });

  it('removes one step', () => {
    expect(order(removeStep(steps, 1))).toEqual([1, 3]);
  });
});

describe('scenario files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'demoflow-record-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('names the file after the scenario', () => {
    expect(scenarioPath(root, 'Create a Customer!')).toBe(
      path.join(root, 'demoflow', 'create-a-customer.demo.json'),
    );
    expect(() => scenarioPath(root, '  ?! ')).toThrow(RecordError);
  });

  it('parses a viewport', () => {
    expect(parseViewport('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(() => parseViewport('wide')).toThrow(RecordError);
    expect(() => parseViewport('0x720')).toThrow(RecordError);
  });

  const scenario = buildScenario('recording', { width: 1280, height: 720 }, [
    { step: { action: 'navigate', path: '/' } },
  ]);

  it('writes a valid scenario', async () => {
    const file = scenarioPath(root, 'recording');
    expect(await saveScenario(file, scenario, false)).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(scenario);
  });

  it('never overwrites an existing file without force', async () => {
    const file = scenarioPath(root, 'recording');
    await saveScenario(file, scenario, false);
    await writeFile(file, 'mine');
    expect(() => assertWritable(file, false)).toThrow(/--force/);
    await expect(saveScenario(file, scenario, false)).rejects.toMatchObject({
      code: 'scenario-exists',
    });
    expect(await readFile(file, 'utf8')).toBe('mine');

    expect(() => assertWritable(file, true)).not.toThrow();
    await saveScenario(file, scenario, true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(scenario);
  });

  it('writes nothing when the recording is not a valid scenario', async () => {
    const file = scenarioPath(root, 'empty');
    await expect(
      saveScenario(file, buildScenario('empty', scenario.viewport!, []), false),
    ).rejects.toMatchObject({ code: 'invalid-recording' });
    await expect(readFile(file)).rejects.toThrow();
  });
});
