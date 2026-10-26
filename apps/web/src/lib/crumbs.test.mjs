import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crumbsFor } from './crumbs.ts';

const labels = {
  overview: 'Overview',
  projects: 'Projects',
  project: 'Project',
  run: 'Run',
  machines: 'Machines',
  settings: 'Settings',
  device: 'Pair a machine',
};
const none = new Map();
const trail = (pathname, names = none) =>
  crumbsFor(pathname, names, labels).map(({ label, href }) =>
    href ? `${label} ${href}` : label,
  );

test('the Overview is a single crumb', () => {
  assert.deepEqual(trail('/app'), ['Overview']);
  assert.deepEqual(trail('/app/'), ['Overview']);
});

test('each top-level page is its own crumb', () => {
  assert.deepEqual(trail('/app/projects'), ['Projects']);
  assert.deepEqual(trail('/app/machines'), ['Machines']);
  assert.deepEqual(trail('/app/settings'), ['Settings']);
  assert.deepEqual(trail('/app/device'), ['Pair a machine']);
});

test('a project page shows the project name under Projects', () => {
  assert.deepEqual(trail('/app/projects/p1', new Map([['p1', 'landing']])), [
    'Projects /app/projects',
    'landing',
  ]);
});

test('a run page shows the project and the scenario names', () => {
  const names = new Map([
    ['p1', 'landing'],
    ['r9', 'sign up'],
  ]);
  assert.deepEqual(trail('/app/projects/p1/runs/r9', names), [
    'Projects /app/projects',
    'landing /app/projects/p1',
    'sign up',
  ]);
});

test('an unnamed segment shows its kind, never the raw id', () => {
  const crumbs = trail('/app/projects/cm8x1/runs/cm9y2');
  assert.deepEqual(crumbs, [
    'Projects /app/projects',
    'Project /app/projects/cm8x1',
    'Run',
  ]);
  assert.ok(crumbs.every((crumb) => !crumb.startsWith('cm')));
});

test('ids are decoded for lookup and encoded in links', () => {
  const names = new Map([['a b', 'Spaced']]);
  assert.deepEqual(trail('/app/projects/a%20b/runs/r', names), [
    'Projects /app/projects',
    'Spaced /app/projects/a%20b',
    'Run',
  ]);
});

test('an unknown path falls back to the Overview', () => {
  assert.deepEqual(trail('/app/nowhere/else'), ['Overview']);
});
