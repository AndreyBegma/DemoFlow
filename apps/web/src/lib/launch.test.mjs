import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed, isActive, launchErrorKey } from './launch.ts';

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

test('elapsed time reads as minutes and seconds', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(7400), '0:07');
  assert.equal(formatElapsed(723000), '12:03');
  assert.equal(formatElapsed(-5), '0:00');
});
