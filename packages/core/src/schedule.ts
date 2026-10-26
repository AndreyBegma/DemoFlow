import { SCHEDULE_WEEKDAYS, type ScheduleConfig } from './project-config.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A weekly slot is at most a week away; a day more covers a DST shift. */
const SEARCH_DAYS = 8;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (format === undefined) {
    // Throws a RangeError for a zone the runtime does not know.
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

/** The wall clock of `zone` at instant `at`, as if it were UTC, to the minute. */
function wallClock(at: number, zone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(at)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return Date.UTC(
    fields.year ?? 0,
    (fields.month ?? 1) - 1,
    fields.day ?? 1,
    fields.hour ?? 0,
    fields.minute ?? 0,
  );
}

/** The earliest whole minute whose wall clock in `zone` is at or past `wall`. */
function firstInstantAt(wall: number, zone: string): number {
  // UTC offsets lie within ±14 h, so the answer is in this range.
  let low = Math.floor((wall - 15 * 60 * MINUTE_MS) / MINUTE_MS);
  let high = Math.ceil((wall + 15 * 60 * MINUTE_MS) / MINUTE_MS);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wallClock(middle * MINUTE_MS, zone) >= wall) high = middle;
    else low = middle + 1;
  }
  return low * MINUTE_MS;
}

/**
 * The instant of wall time `wall` in `zone` (spec 361, Decision 2): a time
 * that repeats when the clocks go back is its first occurrence, and one that
 * does not exist when they go forward is the next valid minute.
 */
function instantOf(wall: number, zone: string): number {
  // Offsets a day either side: at most one transition lies between them.
  const offsets = new Set(
    [wall - DAY_MS, wall + DAY_MS].map((at) => wallClock(at, zone) - at),
  );
  const exact = [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => wallClock(at, zone) === wall);
  return exact.length > 0 ? Math.min(...exact) : firstInstantAt(wall, zone);
}

/** Monday 0 … Sunday 6, as `SCHEDULE_WEEKDAYS` lists them. */
function weekdayOf(day: number): number {
  return (new Date(day).getUTCDay() + 6) % 7;
}

function runsOn(schedule: ScheduleConfig, day: number): boolean {
  const weekday = weekdayOf(day);
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'weekdays':
      return weekday < 5;
    case 'weekly':
      return SCHEDULE_WEEKDAYS[weekday] === schedule.weekday;
  }
}

/** The instant of the slot on local day `day` (midnight, as UTC), or `null`. */
function slotOn(
  schedule: ScheduleConfig,
  day: number,
  zone: string,
): number | null {
  if (!runsOn(schedule, day)) return null;
  const [hours, minutes] = schedule.at.split(':').map(Number);
  return instantOf(
    day + ((hours ?? 0) * 60 + (minutes ?? 0)) * MINUTE_MS,
    zone,
  );
}

/** Local midnight of `now` in `zone`, as UTC. */
function localDay(now: number, zone: string): number {
  const wall = wallClock(now, zone);
  return wall - (wall % DAY_MS);
}

/**
 * Spec 361, Decision 2: the latest slot of `schedule` at or before `now`, in
 * milliseconds since the epoch, for a machine in time zone `zone` (an IANA
 * name). A pass is due when this is later than the last pass's start.
 */
export function lastDueSlot(
  schedule: ScheduleConfig,
  now: number,
  zone: string,
): number {
  const today = localDay(now, zone);
  for (let back = 0; back <= SEARCH_DAYS; back++) {
    const slot = slotOn(schedule, today - back * DAY_MS, zone);
    if (slot !== null && slot <= now) return slot;
  }
  // Unreachable for a valid schedule: every cadence runs once a week.
  throw new RangeError('no slot in the last week');
}

/** The earliest slot of `schedule` after `now`: what `runner status` shows. */
export function nextDueSlot(
  schedule: ScheduleConfig,
  now: number,
  zone: string,
): number {
  const today = localDay(now, zone);
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead++) {
    const slot = slotOn(schedule, today + ahead * DAY_MS, zone);
    if (slot !== null && slot > now) return slot;
  }
  throw new RangeError('no slot in the next week');
}
