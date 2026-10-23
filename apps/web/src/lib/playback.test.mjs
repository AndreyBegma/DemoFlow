import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availability,
  deleteFailureKey,
  orderFormats,
  videoUrl,
} from './playback.ts';

test('a machine that is gone or offline asks the user to reconnect it', () => {
  for (const code of ['runner-offline', 'runner-removed']) {
    assert.equal(deleteFailureKey(code), 'runPage.delete.errors.offline');
  }
});

test('a machine that did not answer or failed asks to try again', () => {
  for (const code of ['runner-timeout', 'runner-error']) {
    assert.equal(deleteFailureKey(code), 'runPage.delete.errors.failed');
  }
});

test('missing files have their own message', () => {
  assert.equal(
    deleteFailureKey('artifacts-missing'),
    'runPage.delete.errors.missing',
  );
});

test('any other failure falls back to the generic message', () => {
  assert.equal(deleteFailureKey('not-found'), 'auth.errors.unknown');
  assert.equal(deleteFailureKey('whatever'), 'auth.errors.unknown');
  assert.equal(deleteFailureKey(undefined), 'auth.errors.unknown');
});

test('formats come back in display order', () => {
  assert.deepEqual(orderFormats(['gif', 'mp4-vertical', 'webm', 'mp4']), [
    'mp4',
    'webm',
    'mp4-vertical',
    'gif',
  ]);
});

test('unknown and duplicate formats are ignored', () => {
  assert.deepEqual(orderFormats(['avi', 'webm', 'webm', 'mov']), ['webm']);
  assert.deepEqual(orderFormats([]), []);
  assert.deepEqual(orderFormats(['avi']), []);
});

test('the default is the first format present', () => {
  assert.equal(orderFormats(['gif', 'mp4-vertical'])[0], 'mp4-vertical');
  assert.equal(orderFormats(['gif', 'mp4'])[0], 'mp4');
});

test('the url goes through the same-origin relay', () => {
  assert.equal(videoUrl('run_1', 'mp4'), '/api/runs/run_1/video/mp4');
  assert.equal(
    videoUrl('run_1', 'mp4-vertical'),
    '/api/runs/run_1/video/mp4-vertical',
  );
  assert.equal(videoUrl('a/b', 'gif'), '/api/runs/a%2Fb/video/gif');
});

test('a removed machine is removed whatever the player did', () => {
  assert.equal(availability(null, false), 'removed');
  assert.equal(availability(null, true), 'removed');
});

test('an offline machine is offline whatever the player did', () => {
  const machine = { name: 'laptop', online: false };
  assert.equal(availability(machine, false), 'offline');
  assert.equal(availability(machine, true), 'offline');
});

test('an online machine plays until the player fails', () => {
  const machine = { name: 'laptop', online: true };
  assert.equal(availability(machine, false), 'ready');
  assert.equal(availability(machine, true), 'failed');
});

test('failed while online, then offline after the refetch', () => {
  assert.equal(availability({ name: 'laptop', online: true }, true), 'failed');
  assert.equal(
    availability({ name: 'laptop', online: false }, true),
    'offline',
  );
});
