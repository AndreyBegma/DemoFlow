/**
 * When a check schedule is due (spec #362, Decision 4). A port of spec 361's
 * `lastDueSlot`: the API does not depend on `@demoflow/core`, so the rule and
 * its test vectors are kept in both places.
 *
 * DST: a local time that does not exist that day falls on the next valid
 * minute; one that repeats falls on its first occurrence.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const CADENCES = ['daily', 'weekdays', 'weekly'] as const;

export type Cadence = (typeof CADENCES)[number];
/** `HH:MM`, 24-hour. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface SlotSchedule {
  cadence: Cadence;
  /** `mon`…`sun`; only with `weekly`. */
  weekday: string | null;
  /** `HH:MM`, 24-hour, local to the zone. */
  at: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Enough days to reach a weekly slot from any day, either way.
const DAYS_SEARCHED = 8;
// The longest DST gap in use is one hour; some zones have moved by more.
const GAP_MINUTES = 180;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(zone, format);
  }
  return format;
}

/** The wall-clock time at `instant` in `zone`, as if it were UTC, in ms. */
function wallTime(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

/** The first instant whose wall time in `zone` is `wall`, or null in a gap. */
function instantOf(wall: number, zone: string): number | null {
  const candidates = [wall - 14 * 60 * MINUTE, wall, wall + 14 * 60 * MINUTE]
    .map((probe) => wall - (wallTime(probe, zone) - probe))
    .filter((candidate) => wallTime(candidate, zone) === wall);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** The slot of the local day `day` (a UTC midnight), or null when none. */
function slotOn(
  schedule: SlotSchedule,
  day: number,
  zone: string,
): number | null {
  const weekday = new Date(day).getUTCDay();
  if (schedule.cadence === 'weekdays' && (weekday === 0 || weekday === 6)) {
    return null;
  }
  if (schedule.cadence === 'weekly' && WEEKDAYS[weekday] !== schedule.weekday) {
    return null;
  }
  const [hours, minutes] = schedule.at.split(':').map(Number);
  const wall = day + hours * 60 * MINUTE + minutes * MINUTE;
  for (let shift = 0; shift <= GAP_MINUTES; shift += 1) {
    const instant = instantOf(wall + shift * MINUTE, zone);
    if (instant !== null) {
      return instant;
    }
  }
  return null;
}

function localDay(now: Date, zone: string): number {
  const wall = wallTime(now.getTime(), zone);
  return wall - (wall % DAY);
}

/** The latest slot at or before `now`, or null when there is none. */
export function lastDueSlot(
  schedule: SlotSchedule,
  now: Date,
  zone: string,
): Date | null {
  const today = localDay(now, zone);
  for (let back = 0; back <= DAYS_SEARCHED; back += 1) {
    const slot = slotOn(schedule, today - back * DAY, zone);
    if (slot !== null && slot <= now.getTime()) {
      return new Date(slot);
    }
  }
  return null;
}

/** The first slot after `now`, or null when there is none. */
export function nextDueSlot(
  schedule: SlotSchedule,
  now: Date,
  zone: string,
): Date | null {
  const today = localDay(now, zone);
  for (let ahead = 0; ahead <= DAYS_SEARCHED; ahead += 1) {
    const slot = slotOn(schedule, today + ahead * DAY, zone);
    if (slot !== null && slot > now.getTime()) {
      return new Date(slot);
    }
  }
  return null;
}
