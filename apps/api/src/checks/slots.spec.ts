import { isTimeZone } from './schedules/time-zone';
import { lastDueSlot, nextDueSlot, type SlotSchedule } from './slots';

function daily(at: string): SlotSchedule {
  return { cadence: 'daily', weekday: null, at };
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

describe('slots', () => {
  describe('lastDueSlot', () => {
    it('is today when the time has passed, yesterday when it has not', () => {
      expect(
        iso(
          lastDueSlot(
            daily('09:30'),
            new Date('2026-10-20T12:00:00Z'),
            'Europe/Berlin',
          ),
        ),
      ).toBe('2026-10-20T07:30:00.000Z');
      expect(
        iso(
          lastDueSlot(
            daily('09:30'),
            new Date('2026-10-20T07:29:59Z'),
            'Europe/Berlin',
          ),
        ),
      ).toBe('2026-10-19T07:30:00.000Z');
    });

    it('counts a slot exactly at now as due', () => {
      expect(
        iso(
          lastDueSlot(daily('12:00'), new Date('2026-10-20T12:00:00Z'), 'UTC'),
        ),
      ).toBe('2026-10-20T12:00:00.000Z');
    });

    it('skips the weekend for weekdays', () => {
      const weekdays: SlotSchedule = {
        cadence: 'weekdays',
        weekday: null,
        at: '09:00',
      };
      // Sunday 2026-10-25.
      const sunday = new Date('2026-10-25T12:00:00Z');
      expect(iso(lastDueSlot(weekdays, sunday, 'UTC'))).toBe(
        '2026-10-23T09:00:00.000Z',
      );
      expect(iso(nextDueSlot(weekdays, sunday, 'UTC'))).toBe(
        '2026-10-26T09:00:00.000Z',
      );
    });

    it('finds the named day for weekly', () => {
      const monday: SlotSchedule = {
        cadence: 'weekly',
        weekday: 'mon',
        at: '09:00',
      };
      // Tuesday 2026-10-20.
      const tuesday = new Date('2026-10-20T12:00:00Z');
      expect(iso(lastDueSlot(monday, tuesday, 'UTC'))).toBe(
        '2026-10-19T09:00:00.000Z',
      );
      expect(iso(nextDueSlot(monday, tuesday, 'UTC'))).toBe(
        '2026-10-26T09:00:00.000Z',
      );
    });

    it('uses the local day of the zone, not the UTC one', () => {
      // 2026-10-20 23:30 in New York is already the 21st in UTC.
      expect(
        iso(
          lastDueSlot(
            daily('23:00'),
            new Date('2026-10-21T03:30:00Z'),
            'America/New_York',
          ),
        ),
      ).toBe('2026-10-21T03:00:00.000Z');
    });
  });

  describe('DST', () => {
    it('moves a missing time to the next valid minute (Europe/Berlin, spring)', () => {
      // 2026-03-29 02:00 CET jumps to 03:00 CEST.
      expect(
        iso(
          lastDueSlot(
            daily('02:30'),
            new Date('2026-03-29T12:00:00Z'),
            'Europe/Berlin',
          ),
        ),
      ).toBe('2026-03-29T01:00:00.000Z');
    });

    it('runs a repeated time once, at its first occurrence (Europe/Berlin, autumn)', () => {
      // 2026-10-25 03:00 CEST falls back to 02:00 CET.
      const schedule = daily('02:30');
      expect(
        iso(
          lastDueSlot(
            schedule,
            new Date('2026-10-25T12:00:00Z'),
            'Europe/Berlin',
          ),
        ),
      ).toBe('2026-10-25T00:30:00.000Z');
      // Between the two occurrences, the next slot is the next day.
      expect(
        iso(
          nextDueSlot(
            schedule,
            new Date('2026-10-25T01:00:00Z'),
            'Europe/Berlin',
          ),
        ),
      ).toBe('2026-10-26T01:30:00.000Z');
    });

    it('moves a missing time to the next valid minute (America/New_York, spring)', () => {
      // 2026-03-08 02:00 EST jumps to 03:00 EDT.
      expect(
        iso(
          lastDueSlot(
            daily('02:30'),
            new Date('2026-03-08T12:00:00Z'),
            'America/New_York',
          ),
        ),
      ).toBe('2026-03-08T07:00:00.000Z');
    });

    it('runs a repeated time once, at its first occurrence (America/New_York, autumn)', () => {
      // 2026-11-01 02:00 EDT falls back to 01:00 EST.
      expect(
        iso(
          lastDueSlot(
            daily('01:30'),
            new Date('2026-11-01T12:00:00Z'),
            'America/New_York',
          ),
        ),
      ).toBe('2026-11-01T05:30:00.000Z');
    });
  });

  describe('isTimeZone', () => {
    it('accepts IANA names and their aliases', () => {
      expect(isTimeZone('Europe/Berlin')).toBe(true);
      expect(isTimeZone('America/New_York')).toBe(true);
      expect(isTimeZone('UTC')).toBe(true);
      expect(isTimeZone('Europe/Kyiv')).toBe(true);
    });

    it('refuses anything else', () => {
      expect(isTimeZone('Mars/Olympus')).toBe(false);
      expect(isTimeZone('')).toBe(false);
      expect(isTimeZone('+02:00')).toBe(false);
      expect(isTimeZone('Europe/Berlin\n')).toBe(false);
    });
  });
});
