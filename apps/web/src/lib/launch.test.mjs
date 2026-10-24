import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canChooseFormats,
  canRunAgain,
  formatElapsed,
  isActive,
  isStartableScenario,
  launchErrorKey,
  launchProgress,
  runAgainFormats,
} from './launch.ts';

const scenarioPath = 'demoflow/checkout/buy.demo.json';
const bound = { rootPath: '/home/me/app', runner: { id: 'm1' } };
const online = { id: 'm1', online: true };

test('a scenario file of the project is startable', () => {
  assert.equal(isStartableScenario(scenarioPath), true);
  assert.equal(isStartableScenario('demoflow/a.demo.json'), true);
});

test('inline and foreign paths are not startable', () => {
  assert.equal(isStartableScenario('inline/abc.demo.json'), false);
  assert.equal(isStartableScenario('demoflow/a.json'), false);
  assert.equal(isStartableScenario('other/a.demo.json'), false);
});

test('run again is ready for the recording machine, online', () => {
  assert.equal(
    canRunAgain({ project: bound, machine: online, scenarioPath }),
    'ready',
  );
});

test('run again is offline when the machine is offline', () => {
  assert.equal(
    canRunAgain({
      project: bound,
      machine: { id: 'm1', online: false },
      scenarioPath,
    }),
    'offline',
  );
});

test('run again is hidden when the click could only fail', () => {
  const hidden = (input) => canRunAgain(input) === 'hidden';
  assert.ok(hidden({ project: null, machine: online, scenarioPath }));
  assert.ok(
    hidden({
      project: { ...bound, rootPath: null },
      machine: online,
      scenarioPath,
    }),
  );
  assert.ok(hidden({ project: bound, machine: null, scenarioPath }));
  assert.ok(
    hidden({
      project: { ...bound, runner: { id: 'm2' } },
      machine: online,
      scenarioPath,
    }),
  );
  assert.ok(
    hidden({
      project: { ...bound, runner: null },
      machine: online,
      scenarioPath,
    }),
  );
  assert.ok(
    hidden({
      project: bound,
      machine: online,
      scenarioPath: 'inline/x.demo.json',
    }),
  );
});

test('every API error code has its own message', () => {
  const expected = {
    'runner-offline': 'runnerOffline',
    'runner-removed': 'runnerRemoved',
    'project-unbound': 'projectUnbound',
    'project-unknown': 'projectUnknown',
    'runner-busy': 'runnerBusy',
    'reporting-off': 'reportingOff',
    'scenario-not-found': 'scenarioNotFound',
    'scenario-invalid': 'scenarioInvalid',
    'config-invalid': 'configInvalid',
    'runner-timeout': 'runnerTimeout',
    'runner-error': 'runnerError',
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.equal(launchErrorKey(code), `projects.launch.errors.${key}`);
  }
});

test('an unknown or missing code falls back to the generic message', () => {
  assert.equal(launchErrorKey('nope'), 'auth.errors.unknown');
  assert.equal(launchErrorKey(undefined), 'auth.errors.unknown');
});

test('starting, running and cancelling are active', () => {
  for (const state of ['starting', 'running', 'cancelling']) {
    assert.equal(isActive(state), true);
  }
});

test('terminal and lost states are not active', () => {
  for (const state of ['passed', 'failed', 'cancelled', 'timed-out', 'lost']) {
    assert.equal(isActive(state), false);
  }
});

test('progress shows the phase of a running launch', () => {
  const running = (progress) => ({ state: 'running', progress });
  assert.deepEqual(
    launchProgress(running({ phase: 'app', step: null, steps: null })),
    { key: 'projects.launch.progress.app' },
  );
  assert.deepEqual(
    launchProgress(running({ phase: 'rendering', step: null, steps: null })),
    { key: 'projects.launch.progress.rendering' },
  );
  assert.deepEqual(
    launchProgress(running({ phase: 'steps', step: 3, steps: 7 })),
    { key: 'projects.launch.progress.steps', step: 3, steps: 7 },
  );
});

test('progress is null unless the launch is running with a known phase', () => {
  const steps = { phase: 'steps', step: 3, steps: 7 };
  assert.equal(launchProgress({ state: 'starting', progress: steps }), null);
  assert.equal(launchProgress({ state: 'passed', progress: steps }), null);
  assert.equal(launchProgress({ state: 'running', progress: null }), null);
  assert.equal(launchProgress({ state: 'running' }), null);
  assert.equal(
    launchProgress({
      state: 'running',
      progress: { phase: 'warming-up', step: null, steps: null },
    }),
    null,
  );
});

test('progress steps with inconsistent numbers is null', () => {
  const steps = (step, total) => ({
    state: 'running',
    progress: { phase: 'steps', step, steps: total },
  });
  assert.equal(launchProgress(steps(8, 7)), null);
  assert.equal(launchProgress(steps(0, 7)), null);
  assert.equal(launchProgress(steps(null, 7)), null);
  assert.equal(launchProgress(steps(3, null)), null);
});

test('only a machine announcing formats can choose them', () => {
  assert.equal(canChooseFormats(['formats']), true);
  assert.equal(canChooseFormats([]), false);
  assert.equal(canChooseFormats(undefined), false);
  assert.equal(canChooseFormats(null), false);
});

test('run again repeats the rendered formats when the machine takes them', () => {
  assert.deepEqual(runAgainFormats(['mp4', 'gif'], ['formats']), [
    'mp4',
    'gif',
  ]);
  assert.equal(runAgainFormats([], ['formats']), undefined);
  assert.equal(runAgainFormats(['mp4'], []), undefined);
  assert.equal(runAgainFormats(['mp4'], undefined), undefined);
});

test('the formats errors have their own messages', () => {
  assert.equal(
    launchErrorKey('runner-outdated'),
    'projects.launch.errors.runnerOutdated',
  );
  assert.equal(
    launchErrorKey('options-invalid'),
    'projects.launch.errors.optionsInvalid',
  );
});

test('elapsed time reads as minutes and seconds', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(7400), '0:07');
  assert.equal(formatElapsed(723000), '12:03');
  assert.equal(formatElapsed(-5), '0:00');
});
