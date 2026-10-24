import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkDeleteOutcome, runDeleteOutcome } from './run-delete.ts';

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

test('a bulk delete that removed every run reports none already gone', () => {
  assert.deepEqual(bulkDeleteOutcome({ ok: true, data: { deleted: 3 } }, 3), {
    kind: 'deleted',
    alreadyGone: 0,
  });
});

test('a bulk delete that removed fewer reports the rest as already gone', () => {
  assert.deepEqual(bulkDeleteOutcome({ ok: true, data: { deleted: 1 } }, 3), {
    kind: 'deleted',
    alreadyGone: 2,
  });
});

test('a bulk delete on a project that is gone is not found', () => {
  assert.deepEqual(
    bulkDeleteOutcome({ ok: false, status: 404, error: 'unknown' }, 3),
    { kind: 'notFound' },
  );
});

test('a bulk delete server failure is an error', () => {
  assert.deepEqual(
    bulkDeleteOutcome({ ok: false, status: 500, error: 'unknown' }, 3),
    { kind: 'error' },
  );
});

test('a bulk delete network failure, with no status, is an error', () => {
  assert.deepEqual(bulkDeleteOutcome({ ok: false, error: 'unknown' }, 3), {
    kind: 'error',
  });
});
