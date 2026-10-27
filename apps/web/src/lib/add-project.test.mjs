import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  addProjectReducer,
  canAdd,
  canCreateConfig,
  createInspector,
  folderErrorKey,
  githubUrlValue,
  INITIAL_STATE,
  INSPECT_DELAY_MS,
  inspectionResult,
  isProjectName,
  machineChoice,
  pathPlaceholder,
  preselectMachine,
} from './add-project.ts';

const inspection = {
  rootPath: '/home/me/app',
  name: 'app',
  hasConfig: true,
  configValid: true,
  scenarios: [{ id: 'demoflow/a.demo.json', name: 'Login' }],
  githubUrl: 'https://github.com/me/app',
};
const noConfig = {
  ...inspection,
  hasConfig: false,
  configValid: false,
  scenarios: [],
};

/** Runs the events through the reducer from the initial state. */
function play(...events) {
  return events.reduce(addProjectReducer, INITIAL_STATE);
}

test('only an online machine announcing projects can be chosen', () => {
  assert.equal(
    machineChoice({ online: true, features: ['projects'] }),
    'ready',
  );
  assert.equal(
    machineChoice({ online: false, features: ['projects'] }),
    'offline',
  );
  assert.equal(machineChoice({ online: true, features: [] }), 'outdated');
  assert.equal(machineChoice({ online: true }), 'outdated');
});

test('the machine of the latest run is preselected when it can be chosen', () => {
  const machines = [
    { id: 'a', online: true, features: ['projects'] },
    { id: 'b', online: true, features: ['projects'] },
    { id: 'c', online: false, features: ['projects'] },
  ];
  const run = (runnerId, startedAt) => ({
    runner: { id: runnerId },
    lastRun: { startedAt },
  });
  assert.equal(
    preselectMachine(machines, [
      run('a', '2026-10-01T00:00:00Z'),
      run('b', '2026-10-02T00:00:00Z'),
    ]),
    'b',
  );
  // The latest run's machine is offline: the first that can be chosen.
  assert.equal(
    preselectMachine(machines, [run('c', '2026-10-03T00:00:00Z')]),
    'a',
  );
  assert.equal(preselectMachine(machines, []), 'a');
  assert.equal(preselectMachine([machines[2]], []), '');
});

test('the path placeholder follows the machine platform', () => {
  assert.equal(pathPlaceholder('win32 10.0.22631'), 'C:\\Users\\you\\my-app');
  assert.equal(pathPlaceholder('darwin 24.1.0'), '/Users/you/my-app');
  assert.equal(pathPlaceholder('linux 6.19.10'), '/home/you/my-app');
  assert.equal(pathPlaceholder(undefined), '/home/you/my-app');
});

test('an inspection is found, without config, or with an invalid one', () => {
  assert.equal(inspectionResult(inspection), 'found');
  assert.equal(inspectionResult(noConfig), 'no-config');
  assert.equal(
    inspectionResult({ ...inspection, configValid: false }),
    'config-invalid',
  );
});

test('every folder error code has its own message', () => {
  const expected = {
    'path-not-allowed': 'pathNotAllowed',
    'config-missing': 'configMissing',
    'config-invalid': 'configInvalid',
    'runner-not-found': 'runnerNotFound',
    'runner-offline': 'runnerOffline',
    'runner-outdated': 'runnerOutdated',
    'runner-busy': 'runnerBusy',
    'runner-timeout': 'runnerTimeout',
    'runner-error': 'runnerError',
    'project-exists': 'projectExists',
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.equal(
      folderErrorKey({ error: 'invalid', code }),
      `projects.add.errors.${key}`,
    );
  }
  assert.equal(
    folderErrorKey({ error: 'rate_limited' }),
    'auth.errors.rateLimited',
  );
  assert.equal(
    folderErrorKey({ error: 'invalid' }),
    'projects.add.errors.invalid',
  );
  assert.equal(folderErrorKey({ error: 'unknown' }), 'auth.errors.unknown');
});

test('a GitHub link is a repository page or nothing', () => {
  assert.deepEqual(githubUrlValue('  '), { ok: true, url: null });
  assert.deepEqual(githubUrlValue(' https://github.com/me/app '), {
    ok: true,
    url: 'https://github.com/me/app',
  });
  for (const bad of [
    'http://github.com/me/app',
    'https://gitlab.com/me/app',
    'https://user:token@github.com/me/app',
    'https://github.com/me/app/tree/main',
  ]) {
    assert.deepEqual(githubUrlValue(bad), { ok: false });
  }
});

test('a project name is 1 to 200 characters', () => {
  assert.equal(isProjectName(' app '), true);
  assert.equal(isProjectName('  '), false);
  assert.equal(isProjectName('a'.repeat(200)), true);
  assert.equal(isProjectName('a'.repeat(201)), false);
});

test('a folder with a valid config can be added', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    { type: 'inspected', seq: 1, inspection },
  );
  assert.equal(state.phase, 'inspected');
  assert.equal(canAdd(state), true);
  assert.equal(canCreateConfig(state), false);
  const done = [
    { type: 'register-started', seq: 1 },
    { type: 'registered', seq: 1, projectId: 'p1' },
  ].reduce(addProjectReducer, state);
  assert.deepEqual(done, { phase: 'done', seq: 1, projectId: 'p1' });
});

test('a folder without config offers Create config, then is found', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    { type: 'inspected', seq: 1, inspection: noConfig },
  );
  assert.equal(canAdd(state), false);
  assert.equal(canCreateConfig(state), true);
  const created = ['demoflow.config.json', 'demoflow/first.demo.json'];
  const after = [
    { type: 'init-started', seq: 1 },
    { type: 'initialised', seq: 1, created, inspection },
  ].reduce(addProjectReducer, state);
  assert.equal(after.phase, 'inspected');
  assert.deepEqual(after.created, created);
  assert.equal(canAdd(after), true);
});

test('an invalid config offers neither action', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    {
      type: 'inspected',
      seq: 1,
      inspection: { ...inspection, configValid: false },
    },
  );
  assert.equal(canAdd(state), false);
  assert.equal(canCreateConfig(state), false);
  assert.equal(
    addProjectReducer(state, { type: 'register-started', seq: 1 }),
    state,
  );
});

test('a refused folder fails with the allow-roots message and no Add', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    {
      type: 'inspect-failed',
      seq: 1,
      error: 'projects.add.errors.pathNotAllowed',
    },
  );
  assert.deepEqual(state, {
    phase: 'failed',
    seq: 1,
    error: 'projects.add.errors.pathNotAllowed',
  });
  assert.equal(canAdd(state), false);
});

test('a folder that is already a project offers to open it', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    { type: 'inspected', seq: 1, inspection },
    { type: 'register-started', seq: 1 },
    {
      type: 'register-failed',
      seq: 1,
      error: 'projects.add.errors.projectExists',
      existingId: 'p0',
    },
  );
  assert.equal(state.phase, 'inspected');
  assert.equal(state.error, 'projects.add.errors.projectExists');
  assert.equal(state.existingId, 'p0');
});

test('a stale answer is never shown', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    { type: 'changed', seq: 2, ready: true },
    { type: 'inspected', seq: 1, inspection: noConfig },
  );
  assert.deepEqual(state, { phase: 'inspecting', seq: 2 });
  const failed = addProjectReducer(state, {
    type: 'inspect-failed',
    seq: 1,
    error: 'projects.add.errors.pathNotAllowed',
  });
  assert.equal(failed, state);
  assert.equal(
    addProjectReducer(state, { type: 'inspected', seq: 2, inspection }).phase,
    'inspected',
  );
});

test('an older change does not undo a newer one', () => {
  const state = play(
    { type: 'changed', seq: 2, ready: true },
    { type: 'changed', seq: 1, ready: false },
  );
  assert.deepEqual(state, { phase: 'inspecting', seq: 2 });
});

test('clearing the path goes back to idle and drops the pending answer', () => {
  const state = play(
    { type: 'changed', seq: 1, ready: true },
    { type: 'changed', seq: 2, ready: false },
    { type: 'inspected', seq: 1, inspection },
  );
  assert.deepEqual(state, { phase: 'idle', seq: 2 });
});

test('typing quickly sends one inspection per pause', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent = [];
    const inspector = createInspector({
      inspect: async (seq) => {
        sent.push(seq);
      },
    });
    // Five keystrokes, each within the pause of the one before.
    for (let seq = 1; seq <= 5; seq++) {
      inspector.change(seq, true);
      mock.timers.tick(INSPECT_DELAY_MS - 1);
    }
    assert.deepEqual(sent, []);
    mock.timers.tick(1);
    assert.deepEqual(sent, [5]);
    // A pause, then two more keystrokes: one more inspection.
    inspector.change(6, true);
    mock.timers.tick(100);
    inspector.change(7, true);
    mock.timers.tick(INSPECT_DELAY_MS);
    assert.deepEqual(sent, [5, 7]);
  } finally {
    mock.timers.reset();
  }
});

test('an empty path or a disposed dialog sends nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent = [];
    const inspector = createInspector({
      inspect: async (seq) => {
        sent.push(seq);
      },
    });
    inspector.change(1, true);
    inspector.change(2, false);
    mock.timers.tick(INSPECT_DELAY_MS * 2);
    inspector.change(3, true);
    inspector.dispose();
    mock.timers.tick(INSPECT_DELAY_MS * 2);
    assert.deepEqual(sent, []);
  } finally {
    mock.timers.reset();
  }
});
