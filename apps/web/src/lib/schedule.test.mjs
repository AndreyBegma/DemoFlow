import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultZone,
  formatUntil,
  formError,
  formFor,
  healthOrder,
  isValidTime,
  MAX_EXCLUDES,
  pausedKey,
  scheduleBody,
  scheduleErrorKey,
  toggleExclude,
} from './schedule.ts';

const saved = {
  source: 'site',
  cadence: 'weekly',
  weekday: 'thu',
  at: '18:15',
  timeZone: 'Europe/Berlin',
  exclude: ['demoflow/a.demo.json'],
  pausedReason: null,
  nextDueAt: null,
  lastPassAt: null,
};

test('a new schedule starts on weekdays at 09:00 in the given zone', () => {
  assert.deepEqual(formFor(null, 'Europe/Kyiv'), {
    cadence: 'weekdays',
    weekday: 'mon',
    at: '09:00',
    timeZone: 'Europe/Kyiv',
    exclude: [],
  });
});

test('an existing schedule fills the form', () => {
  const form = formFor(saved, 'UTC');
  assert.equal(form.cadence, 'weekly');
  assert.equal(form.weekday, 'thu');
  assert.equal(form.at, '18:15');
  assert.equal(form.timeZone, 'Europe/Berlin');
  assert.deepEqual(form.exclude, ['demoflow/a.demo.json']);
  assert.notEqual(form.exclude, saved.exclude);
});

test('a schedule without a weekday falls back to Monday for the hidden select', () => {
  assert.equal(
    formFor({ ...saved, cadence: 'daily', weekday: null }, 'UTC').weekday,
    'mon',
  );
});

test('the machine zone wins over the browser zone', () => {
  assert.equal(defaultZone('Asia/Tokyo', 'Europe/Berlin'), 'Asia/Tokyo');
  assert.equal(defaultZone(null, 'Europe/Berlin'), 'Europe/Berlin');
  assert.equal(defaultZone(null, undefined), 'UTC');
});

test('weekly sends its weekday; daily and weekdays send none', () => {
  const form = formFor(saved, 'UTC');
  assert.deepEqual(scheduleBody(form), {
    cadence: 'weekly',
    weekday: 'thu',
    at: '18:15',
    timeZone: 'Europe/Berlin',
    exclude: ['demoflow/a.demo.json'],
  });
  for (const cadence of ['daily', 'weekdays']) {
    const body = scheduleBody({ ...form, cadence });
    assert.equal(body.cadence, cadence);
    assert.equal('weekday' in body, false);
  }
});

test('the body drops duplicate excludes', () => {
  const form = { ...formFor(null, 'UTC'), exclude: ['a', 'b', 'a'] };
  assert.deepEqual(scheduleBody(form).exclude, ['a', 'b']);
});

test('only HH:MM in 24 hours is a valid time', () => {
  for (const at of ['00:00', '09:30', '23:59']) {
    assert.equal(isValidTime(at), true, at);
  }
  for (const at of ['', '9:30', '24:00', '25:00', '12:60', '12:3', 'ab:cd']) {
    assert.equal(isValidTime(at), false, at);
  }
});

test('an invalid time, an empty zone or too many excludes cannot be saved', () => {
  const form = formFor(null, 'UTC');
  assert.equal(formError(form), null);
  assert.equal(formError({ ...form, at: '25:00' }), 'time');
  assert.equal(formError({ ...form, at: '' }), 'time');
  assert.equal(formError({ ...form, timeZone: ' ' }), 'zone');
  const many = Array.from({ length: MAX_EXCLUDES + 1 }, (_, i) => `s${i}`);
  assert.equal(formError({ ...form, exclude: many }), 'exclude');
});

test('ticking a scenario leaves it out; unticking brings it back', () => {
  assert.deepEqual(toggleExclude([], 'a', true), ['a']);
  assert.deepEqual(toggleExclude(['a'], 'a', true), ['a']);
  assert.deepEqual(toggleExclude(['a', 'b'], 'a', false), ['b']);
});

test('the next check reads as a time ahead', () => {
  const now = Date.parse('2026-10-26T08:00:00Z');
  assert.equal(formatUntil('2026-10-26T08:00:30Z', now), null);
  assert.equal(formatUntil('2026-10-26T07:00:00Z', now), null);
  assert.equal(formatUntil('2026-10-26T08:30:00Z', now), 'in 30 minutes');
  assert.equal(formatUntil('2026-10-26T09:30:00Z', now), 'in 2 hours');
  assert.equal(formatUntil('2026-10-27T08:00:00Z', now), 'tomorrow');
  assert.equal(formatUntil('2026-10-29T08:00:00Z', now), 'in 3 days');
});

test('each paused reason has its banner', () => {
  assert.equal(
    pausedKey('config-schedule'),
    'projects.schedule.paused.configSchedule',
  );
  assert.equal(pausedKey('no-machine'), 'projects.schedule.paused.noMachine');
  assert.equal(pausedKey('cli-too-old'), 'projects.schedule.paused.cliTooOld');
  assert.equal(pausedKey(null), null);
  assert.equal(pausedKey('something-new'), null);
});

test('save errors map to their messages', () => {
  assert.equal(
    scheduleErrorKey(409, 'config-schedule'),
    'projects.schedule.errors.configSchedule',
  );
  assert.equal(
    scheduleErrorKey(409, 'no-machine'),
    'projects.schedule.errors.noMachine',
  );
  assert.equal(scheduleErrorKey(404, 'not-found'), 'projects.errors.notFound');
  assert.equal(
    scheduleErrorKey(400, undefined),
    'projects.schedule.errors.invalid',
  );
  assert.equal(scheduleErrorKey(undefined, undefined), 'auth.errors.unknown');
});

test('stale scenarios come first, then by name', () => {
  const rows = [
    { scenarioName: 'b', state: 'passed' },
    { scenarioName: 'c', state: 'failed' },
    { scenarioName: 'a', state: 'passed' },
    { scenarioName: 'a', state: 'failed' },
  ];
  assert.deepEqual(
    healthOrder(rows).map((row) => `${row.state}:${row.scenarioName}`),
    ['failed:a', 'failed:c', 'passed:a', 'passed:b'],
  );
});
