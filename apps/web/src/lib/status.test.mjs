import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactStatus,
  lastRunStatus,
  launchStatus,
  machineStatus,
  PILL_STATUS,
  runStatus,
  stageStatus,
  videoStatus,
} from './status.ts';

test('every kind is drawn with its own Glass UI pill state', () => {
  assert.deepEqual(PILL_STATUS, {
    running: 'running',
    passed: 'done',
    failed: 'error',
    unavailable: 'paused',
    idle: 'idle',
  });
  assert.equal(new Set(Object.values(PILL_STATUS)).size, 5);
});

test('a run is passed or failed', () => {
  assert.deepEqual(runStatus('passed'), {
    kind: 'passed',
    label: 'status.passed',
  });
  assert.deepEqual(runStatus('failed'), {
    kind: 'failed',
    label: 'status.failed',
  });
});

test('a project without a last run has never run', () => {
  assert.deepEqual(lastRunStatus(null), {
    kind: 'idle',
    label: 'status.neverRun',
  });
  assert.deepEqual(lastRunStatus({ status: 'failed' }), runStatus('failed'));
  assert.deepEqual(lastRunStatus({ status: 'passed' }), runStatus('passed'));
});

test('every launch state maps to a kind and its own label', () => {
  const cases = {
    starting: ['running', 'status.starting'],
    running: ['running', 'status.running'],
    cancelling: ['running', 'status.cancelling'],
    passed: ['passed', 'status.passed'],
    failed: ['failed', 'status.failed'],
    'timed-out': ['failed', 'status.timedOut'],
    cancelled: ['idle', 'status.cancelled'],
    lost: ['unavailable', 'status.lost'],
  };
  for (const [state, [kind, label]] of Object.entries(cases)) {
    assert.deepEqual(launchStatus(state), { kind, label }, state);
  }
});

test('a finished launch reads the same as the run it produced', () => {
  assert.deepEqual(launchStatus('passed'), runStatus('passed'));
  assert.deepEqual(launchStatus('failed'), runStatus('failed'));
});

test('every stage status maps to a kind', () => {
  const cases = {
    pending: ['idle', 'status.pending'],
    running: ['running', 'status.running'],
    passed: ['passed', 'status.passed'],
    failed: ['failed', 'status.failed'],
    skipped: ['idle', 'status.skipped'],
  };
  for (const [state, [kind, label]] of Object.entries(cases)) {
    assert.deepEqual(stageStatus(state), { kind, label }, state);
  }
});

test('an online machine is a success pill, an offline one is unavailable', () => {
  assert.deepEqual(machineStatus(true), {
    kind: 'passed',
    label: 'status.online',
  });
  assert.deepEqual(machineStatus(false), {
    kind: 'unavailable',
    label: 'status.offline',
  });
  assert.notEqual(machineStatus(true).kind, 'running');
});

test('deleted files are unavailable, present files show nothing', () => {
  assert.equal(artifactStatus({ artifactsDeletedAt: null }), null);
  assert.deepEqual(
    artifactStatus({ artifactsDeletedAt: '2026-10-01T00:00:00Z' }),
    {
      kind: 'unavailable',
      label: 'status.filesDeleted',
    },
  );
});

test('the video says why it cannot play, or nothing when it can', () => {
  const run = { artifactsDeletedAt: null, formats: ['mp4'] };
  assert.equal(videoStatus(run, { online: true }), null);
  assert.deepEqual(videoStatus(run, { online: false }), machineStatus(false));
  assert.deepEqual(videoStatus(run, null), {
    kind: 'unavailable',
    label: 'status.machineRemoved',
  });
  assert.deepEqual(videoStatus({ ...run, formats: [] }, { online: true }), {
    kind: 'idle',
    label: 'status.noVideo',
  });
  assert.deepEqual(
    videoStatus(
      { artifactsDeletedAt: '2026-10-01T00:00:00Z', formats: ['mp4'] },
      { online: false },
    ),
    { kind: 'unavailable', label: 'status.filesDeleted' },
  );
});
