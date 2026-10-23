import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes } from './format-bytes.ts';

test('under 1 KB is shown in bytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('under 1 MB is shown in whole KB', () => {
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1048575), '1024 KB');
});

test('from 1 MB it is shown in MB with one decimal', () => {
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300.0 MB');
  assert.equal(formatBytes(12.3 * 1024 * 1024), '12.3 MB');
});
