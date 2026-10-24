import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDeleteOutcome } from './run-delete.ts';

test('a deleted run is gone', () => {
  assert.equal(runDeleteOutcome({ ok: true }), 'gone');
});

test('a run that was already deleted is gone too', () => {
  assert.equal(
    runDeleteOutcome({ ok: false, status: 404, error: 'unknown' }),
    'gone',
  );
});

test('a server failure keeps the page and shows an error', () => {
  assert.equal(
    runDeleteOutcome({ ok: false, status: 500, error: 'unknown' }),
    'error',
  );
});

test('a network failure, with no status, shows an error', () => {
  assert.equal(runDeleteOutcome({ ok: false, error: 'unknown' }), 'error');
});
