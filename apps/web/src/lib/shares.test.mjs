import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canExtend,
  daysLeft,
  defaultShareFormat,
  markdownSnippet,
  quotaPreview,
  shareButtonState,
  shareErrorKey,
  shareFailureKey,
  shareFor,
  shareFormatOptions,
  sharePasswordError,
  shareRowActions,
} from './shares.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const at = (days) => new Date(NOW + days * DAY).toISOString();

const run = { formats: ['mp4', 'gif'], artifactsDeletedAt: null };
const machine = { online: true, features: ['share'] };

test('the Share button is enabled for a rendered run on an online machine that shares', () => {
  assert.equal(shareButtonState(run, machine), 'ready');
});

test('a run without a render cannot be shared', () => {
  assert.equal(shareButtonState({ ...run, formats: [] }, machine), 'noRender');
});

test('a run whose files were deleted cannot be shared', () => {
  assert.equal(
    shareButtonState({ ...run, artifactsDeletedAt: at(-1) }, machine),
    'deleted',
  );
});

test('a run whose machine was removed cannot be shared', () => {
  assert.equal(shareButtonState(run, null), 'removed');
});

test('a run on an offline machine cannot be shared', () => {
  assert.equal(shareButtonState(run, { ...machine, online: false }), 'offline');
});

test('a machine that does not announce share must be updated first', () => {
  assert.equal(
    shareButtonState(run, { online: true, features: [] }),
    'outdated',
  );
  assert.equal(shareButtonState(run, { online: true }), 'outdated');
});

test('format options carry their size and mark a render over the limit', () => {
  const renders = [
    { format: 'mp4', width: 1, height: 1, sizeBytes: 300, durationMs: 1 },
    { format: 'gif', width: 1, height: 1, sizeBytes: 100, durationMs: 1 },
  ];
  assert.deepEqual(shareFormatOptions(['mp4', 'gif', 'webm'], renders, 200), [
    { format: 'mp4', sizeBytes: 300, tooLarge: true },
    { format: 'gif', sizeBytes: 100, tooLarge: false },
    { format: 'webm', sizeBytes: null, tooLarge: false },
  ]);
});

test('the default format is the first one that fits', () => {
  assert.equal(
    defaultShareFormat([
      { format: 'mp4', sizeBytes: 300, tooLarge: true },
      { format: 'gif', sizeBytes: 100, tooLarge: false },
    ]),
    'gif',
  );
  assert.equal(
    defaultShareFormat([{ format: 'mp4', sizeBytes: 300, tooLarge: true }]),
    'mp4',
  );
  assert.equal(defaultShareFormat([]), null);
});

test('the quota preview adds the share and says whether it fits', () => {
  const quota = { usedBytes: 700, limitBytes: 1000 };
  assert.deepEqual(quotaPreview(quota, 300), {
    usedBytes: 700,
    afterBytes: 1000,
    limitBytes: 1000,
    fits: true,
  });
  assert.equal(quotaPreview(quota, 301).fits, false);
  assert.equal(quotaPreview(quota).afterBytes, 700);
  assert.equal(quotaPreview(quota, null).fits, true);
});

test('the run already shared in a format finds that share', () => {
  const shares = [
    { id: 'a', runId: 'r1', format: 'gif' },
    { id: 'b', runId: 'r1', format: 'mp4' },
    { id: 'c', runId: 'r2', format: 'mp4' },
  ];
  assert.equal(shareFor(shares, 'r1', 'mp4')?.id, 'b');
  assert.equal(shareFor(shares, 'r2', 'gif'), null);
});

test('days left round up and stop at zero', () => {
  assert.equal(daysLeft(at(30), NOW), 30);
  assert.equal(daysLeft(at(0.2), NOW), 1);
  assert.equal(daysLeft(at(-2), NOW), 0);
});

test('Extend is offered below the 90-day cap and hidden at it', () => {
  assert.equal(canExtend({ status: 'ready', expiresAt: at(30) }, NOW), true);
  assert.equal(canExtend({ status: 'ready', expiresAt: at(89) }, NOW), true);
  assert.equal(canExtend({ status: 'ready', expiresAt: at(89.5) }, NOW), false);
  assert.equal(canExtend({ status: 'ready', expiresAt: at(90) }, NOW), false);
});

test('a failed or lost share cannot be extended', () => {
  assert.equal(canExtend({ status: 'failed', expiresAt: at(7) }, NOW), false);
  assert.equal(canExtend({ status: 'lost', expiresAt: at(7) }, NOW), false);
});

test('row actions follow the status', () => {
  assert.deepEqual(
    shareRowActions({ status: 'ready', expiresAt: at(30) }, NOW),
    {
      copy: true,
      open: true,
      extend: true,
      revoke: true,
      retry: false,
    },
  );
  assert.deepEqual(
    shareRowActions({ status: 'failed', expiresAt: at(30) }, NOW),
    { copy: false, open: false, extend: false, revoke: true, retry: true },
  );
  assert.deepEqual(
    shareRowActions({ status: 'lost', expiresAt: at(30) }, NOW),
    {
      copy: false,
      open: false,
      extend: false,
      revoke: true,
      retry: false,
    },
  );
});

test('a password is optional, 8 to 128 characters, never trimmed', () => {
  assert.equal(sharePasswordError(''), null);
  assert.equal(
    sharePasswordError('1234567'),
    'shares.dialog.password.tooShort',
  );
  assert.equal(sharePasswordError('12345678'), null);
  assert.equal(sharePasswordError('   a    '), null);
  assert.equal(
    sharePasswordError('x'.repeat(129)),
    'shares.dialog.password.tooLong',
  );
});

test('each refusal of the API has its own message', () => {
  assert.equal(shareErrorKey('quota-exceeded'), 'shares.errors.quotaExceeded');
  assert.equal(shareErrorKey('file-too-large'), 'shares.errors.fileTooLarge');
  assert.equal(shareErrorKey('runner-offline'), 'shares.errors.runnerOffline');
  assert.equal(
    shareErrorKey('runner-outdated'),
    'shares.errors.runnerOutdated',
  );
  assert.equal(shareErrorKey('something-new'), 'shares.errors.unknown');
  assert.equal(shareErrorKey(undefined), 'shares.errors.unknown');
});

test('an upload failure is said in words, an unknown one generically', () => {
  assert.equal(shareFailureKey('timed-out'), 'shares.failure.timedOut');
  assert.equal(shareFailureKey('error'), 'shares.failure.unknown');
  assert.equal(shareFailureKey(null), 'shares.failure.unknown');
});

test('the Markdown snippet escapes brackets in the title', () => {
  assert.equal(
    markdownSnippet('Sign in [beta]', 'https://x/s/t/file'),
    '![Sign in \\[beta\\]](https://x/s/t/file)',
  );
});
