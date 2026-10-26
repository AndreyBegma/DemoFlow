import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeNavId, NAV_ITEMS } from './nav.ts';

test('each nav page lights its own item', () => {
  for (const item of NAV_ITEMS) {
    assert.equal(activeNavId(item.href), item.id);
  }
});

test('nested routes light the longest matching item', () => {
  assert.equal(activeNavId('/app/projects/p1'), 'projects');
  assert.equal(activeNavId('/app/projects/p1/runs/r1'), 'projects');
  assert.equal(activeNavId('/app/device'), 'overview');
});

test('a shared prefix that is not a segment does not match', () => {
  assert.equal(activeNavId('/app/projectsx'), 'overview');
  assert.equal(activeNavId('/docs'), null);
});
