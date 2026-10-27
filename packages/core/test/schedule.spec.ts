import { describe, expect, it } from 'vitest';
import {
  lastDueSlot,
  nextDueSlot,
  parseProjectConfig,
  type ScheduleConfig,
} from '../src/index.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

function parsed(schedule: unknown) {
  return parseProjectConfig({ baseUrl: 'http://localhost:3000', schedule });
}

describe('schedule in the project config (spec 361, Decision 1)', () => {
  it.each([
    { cadence: 'daily', at: '09:30' },
    { cadence: 'weekdays', at: '00:00' },
    {
      cadence: 'weekly',
      weekday: 'sun',
      at: '23:59',
      exclude: ['demoflow/wip.demo.json', 'demoflow/a/b.demo.json'],
    },
  ])('accepts %o as written', (schedule) => {
    const result = parsed(schedule);
    expect(result.ok && result.value.schedule).toEqual(schedule);
  });

  it('leaves schedule out when the file has none', () => {
    const result = parseProjectConfig({ baseUrl: 'http://localhost:3000' });
    expect(result.ok && 'schedule' in result.value).toBe(false);
  });

  it.each([
    ['weekly without a weekday', { cadence: 'weekly', at: '09:30' }],
    ['a weekday with daily', { cadence: 'daily', weekday: 'mon', at: '09:30' }],
    [
      'a weekday with weekdays',
      { cadence: 'weekdays', weekday: 'fri', at: '09:30' },
    ],
    ['an hour without its zero', { cadence: 'daily', at: '9:30' }],
    ['24:00', { cadence: 'daily', at: '24:00' }],
    ['seconds', { cadence: 'daily', at: '09:30:00' }],
    ['an unknown cadence', { cadence: 'hourly', at: '09:30' }],
    ['an unknown key', { cadence: 'daily', at: '09:30', zone: 'UTC' }],
    [
      'an exclude outside demoflow/',
      { cadence: 'daily', at: '09:30', exclude: ['wip.demo.json'] },
    ],
    [
      'an exclude with ..',
      {
        cadence: 'daily',
        at: '09:30',
        exclude: ['demoflow/../wip.demo.json'],
      },
    ],
    [
      'more than 100 excludes',
      {
        cadence: 'daily',
        at: '09:30',
        exclude: Array.from(
          { length: 101 },
          (_, i) => `demoflow/s${i}.demo.json`,
        ),
      },
    ],
  ])('refuses %s', (_, schedule) => {
    expect(parsed(schedule).ok).toBe(false);
  });
});

const daily: ScheduleConfig = { cadence: 'daily', at: '09:30' };
const weekdays: ScheduleConfig = { cadence: 'weekdays', at: '09:30' };
const weekly: ScheduleConfig = {
  cadence: 'weekly',
  weekday: 'wed',
  at: '18:00',
};

describe('lastDueSlot (spec 361, Decision 2)', () => {
  it('is today once the time has come, else yesterday (daily)', () => {
    expect(iso(lastDueSlot(daily, at('2026-10-21T09:30:00Z'), 'UTC'))).toBe(
      '2026-10-21T09:30:00.000Z',
    );
    expect(iso(lastDueSlot(daily, at('2026-10-21T09:29:59Z'), 'UTC'))).toBe(
      '2026-10-20T09:30:00.000Z',
    );
  });

  it('follows the zone of the machine', () => {
    // 09:30 in Kyiv (UTC+3 in summer) is 06:30 UTC.
    expect(
      iso(lastDueSlot(daily, at('2026-07-01T07:00:00Z'), 'Europe/Kyiv')),
    ).toBe('2026-07-01T06:30:00.000Z');
  });

  it('skips the weekend (weekdays)', () => {
    // Monday 2026-10-26 08:00: the last slot is Friday's.
    expect(iso(lastDueSlot(weekdays, at('2026-10-26T08:00:00Z'), 'UTC'))).toBe(
      '2026-10-23T09:30:00.000Z',
    );
    // Sunday evening: still Friday's.
    expect(iso(lastDueSlot(weekdays, at('2026-10-25T20:00:00Z'), 'UTC'))).toBe(
      '2026-10-23T09:30:00.000Z',
    );
    // Monday after the time: Monday's.
    expect(iso(lastDueSlot(weekdays, at('2026-10-26T10:00:00Z'), 'UTC'))).toBe(
      '2026-10-26T09:30:00.000Z',
    );
  });

  it('is the last weekday given (weekly)', () => {
    // Wednesday 2026-10-21 17:59: last week's Wednesday.
    expect(iso(lastDueSlot(weekly, at('2026-10-21T17:59:00Z'), 'UTC'))).toBe(
      '2026-10-14T18:00:00.000Z',
    );
    expect(iso(lastDueSlot(weekly, at('2026-10-21T18:00:00Z'), 'UTC'))).toBe(
      '2026-10-21T18:00:00.000Z',
    );
    expect(iso(lastDueSlot(weekly, at('2026-10-27T12:00:00Z'), 'UTC'))).toBe(
      '2026-10-21T18:00:00.000Z',
    );
  });

  describe.each([
    {
      zone: 'Europe/Berlin',
      // 2026-03-29: 02:00 CET → 03:00 CEST (01:00 UTC).
      spring: { day: '2026-03-29', instant: '2026-03-29T01:00:00.000Z' },
      // 2026-10-25: 03:00 CEST → 02:00 CET; 02:30 is first 00:30 UTC.
      fall: { at: '02:30', instant: '2026-10-25T00:30:00.000Z' },
    },
    {
      zone: 'America/New_York',
      // 2026-03-08: 02:00 EST → 03:00 EDT (07:00 UTC).
      spring: { day: '2026-03-08', instant: '2026-03-08T07:00:00.000Z' },
      // 2026-11-01: 02:00 EDT → 01:00 EST; 01:30 is first 05:30 UTC.
      fall: { at: '01:30', instant: '2026-11-01T05:30:00.000Z' },
    },
  ])('across DST in $zone', ({ zone, spring, fall }) => {
    const gap: ScheduleConfig = { cadence: 'daily', at: '02:30' };
    const repeated: ScheduleConfig = { cadence: 'daily', at: fall.at };

    it('runs a time that does not exist at the next valid minute', () => {
      const slot = lastDueSlot(gap, at(`${spring.day}T12:00:00Z`), zone);
      expect(iso(slot)).toBe(spring.instant);
      // Just before the jump, the slot is still the day before's.
      expect(lastDueSlot(gap, slot - 60_000, zone)).toBeLessThan(slot);
    });

    it('runs a time that repeats once, at its first occurrence', () => {
      const first = at(fall.instant);
      const second = first + 60 * 60_000;
      expect(iso(lastDueSlot(repeated, first, zone))).toBe(fall.instant);
      // During and after the repeat, the slot stays the first one.
      expect(lastDueSlot(repeated, second, zone)).toBe(first);
      expect(lastDueSlot(repeated, second + 6 * 60 * 60_000, zone)).toBe(first);
      // The day the clocks go back is 25 hours long.
      expect(nextDueSlot(repeated, first, zone)).toBe(first + 25 * 60 * 60_000);
    });

    it('keeps the wall time on the days either side', () => {
      const before = lastDueSlot(
        daily,
        at(`${spring.day}T00:00:00Z`) - 86_400_000,
        zone,
      );
      const after = lastDueSlot(
        daily,
        at(`${spring.day}T00:00:00Z`) + 2 * 86_400_000,
        zone,
      );
      // Three days apart, one of them 23 hours long.
      expect(after - before).toBe(3 * 86_400_000 - 60 * 60_000);
    });
  });
});

describe('nextDueSlot', () => {
  it('is the first slot after now', () => {
    expect(iso(nextDueSlot(daily, at('2026-10-21T09:30:00Z'), 'UTC'))).toBe(
      '2026-10-22T09:30:00.000Z',
    );
    expect(iso(nextDueSlot(weekdays, at('2026-10-23T10:00:00Z'), 'UTC'))).toBe(
      '2026-10-26T09:30:00.000Z',
    );
    expect(iso(nextDueSlot(weekly, at('2026-10-21T18:00:00Z'), 'UTC'))).toBe(
      '2026-10-28T18:00:00.000Z',
    );
  });
});
