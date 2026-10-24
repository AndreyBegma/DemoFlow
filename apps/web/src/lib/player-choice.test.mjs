import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterPlayerError,
  loadVideoPlayer,
  lunaAspectRatio,
} from './player-choice.ts';

test('each run shape maps to the matching Luna frame', () => {
  assert.equal(lunaAspectRatio('landscape'), '16:9');
  assert.equal(lunaAspectRatio('vertical'), '9:16');
  assert.equal(lunaAspectRatio('square'), '1:1');
});

test('a Luna error falls back to the native player', () => {
  assert.equal(afterPlayerError('luna'), 'native');
});

test('a native error is reported to the page', () => {
  assert.equal(afterPlayerError('native'), 'report');
});

test('the loader returns what the importer loads', async () => {
  const luna = () => 'luna';
  const native = () => 'native';
  assert.equal(await loadVideoPlayer(async () => luna, native), luna);
});

test('the loader returns the native player when the import rejects', async () => {
  const native = () => 'native';
  const player = await loadVideoPlayer(
    () => Promise.reject(new Error('ChunkLoadError')),
    native,
  );
  assert.equal(player, native);
});
