import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlineCount, overviewStats } from './overview-stats.ts';

const run = (status) => ({ status });

test('no projects: every tile is zero', () => {
  assert.deepEqual(overviewStats([]), { projects: 0, runs: 0, failing: 0 });
});

test('tiles count projects, sum runs and count failing last runs', () => {
  const projects = [
    { runCount: 12, lastRun: run('passed') },
    { runCount: 3, lastRun: run('failed') },
    { runCount: 0, lastRun: null },
    { runCount: 7, lastRun: run('failed') },
  ];
  assert.deepEqual(overviewStats(projects), {
    projects: 4,
    runs: 22,
    failing: 2,
  });
});

test('onlineCount counts connected machines', () => {
  assert.equal(onlineCount([]), 0);
  assert.equal(
    onlineCount([{ online: true }, { online: false }, { online: true }]),
    2,
  );
});
