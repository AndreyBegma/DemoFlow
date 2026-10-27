// Rules for the "Scheduled checks" card (spec #363). Plain functions, so they
// are unit-tested without a browser.

import type { CheckSchedule, ScheduleBody, ScheduleCadence } from './api';

export const CADENCES: readonly ScheduleCadence[] = [
  'daily',
  'weekdays',
  'weekly',
];

/** Monday first, the way a person reads a week. */
export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** `HH:MM`, 24-hour: the API's rule (spec #362, Decision 3). */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** At most this many scenarios left out of a pass (spec #362). */
export const MAX_EXCLUDES = 100;

/** What the form holds; `weekday` is kept while hidden so Weekly remembers it. */
export interface ScheduleForm {
  cadence: ScheduleCadence;
  weekday: Weekday;
  at: string;
  timeZone: string;
  exclude: string[];
}

function isWeekday(value: string | null): value is Weekday {
  return (WEEKDAYS as readonly (string | null)[]).includes(value);
}

/** The zone a new schedule starts in: the machine's when known, else the browser's. */
export function defaultZone(
  machineZone: string | null | undefined,
  browserZone: string | undefined,
): string {
  return machineZone || browserZone || 'UTC';
}

/** The form for an existing schedule, or a new one (weekdays at 09:00) in `zone`. */
export function formFor(
  schedule: CheckSchedule | null,
  zone: string,
): ScheduleForm {
  if (schedule === null) {
    return {
      cadence: 'weekdays',
      weekday: 'mon',
      at: '09:00',
      timeZone: zone,
      exclude: [],
    };
  }
  return {
    cadence: schedule.cadence,
    weekday: isWeekday(schedule.weekday) ? schedule.weekday : 'mon',
    at: schedule.at,
    timeZone: schedule.timeZone,
    exclude: [...schedule.exclude],
  };
}

export function isValidTime(at: string): boolean {
  return TIME_OF_DAY.test(at);
}

export type ScheduleFormError = 'time' | 'zone' | 'exclude';

/** Why the form cannot be saved, or null when it can. */
export function formError(form: ScheduleForm): ScheduleFormError | null {
  if (!isValidTime(form.at)) return 'time';
  if (form.timeZone.trim().length === 0) return 'zone';
  if (form.exclude.length > MAX_EXCLUDES) return 'exclude';
  return null;
}

/** The `PUT` body: `weekday` only with `weekly`, which the API requires. */
export function scheduleBody(form: ScheduleForm): ScheduleBody {
  const body: ScheduleBody = {
    cadence: form.cadence,
    at: form.at,
    timeZone: form.timeZone,
    exclude: [...new Set(form.exclude)],
  };
  if (form.cadence === 'weekly') body.weekday = form.weekday;
  return body;
}

/** Ticks or unticks one scenario id in the "Leave out" list. */
export function toggleExclude(
  exclude: readonly string[],
  id: string,
  excluded: boolean,
): string[] {
  const rest = exclude.filter((candidate) => candidate !== id);
  return excluded ? [...rest, id] : rest;
}

const future = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "in 3 hours" for an ISO time ahead of `now` (epoch ms). Under a minute, or
 * already past, returns null so the caller can say "any moment".
 */
export function formatUntil(iso: string, now: number): string | null {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds < 60) return null;
  if (seconds < 3600) return future.format(Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return future.format(Math.round(seconds / 3600), 'hour');
  return future.format(Math.round(seconds / 86400), 'day');
}

export type PausedKey =
  | 'projects.schedule.paused.configSchedule'
  | 'projects.schedule.paused.noMachine'
  | 'projects.schedule.paused.cliTooOld';

/** The banner for a paused schedule; null when it runs or the reason is new. */
export function pausedKey(reason: string | null): PausedKey | null {
  switch (reason) {
    case 'config-schedule':
      return 'projects.schedule.paused.configSchedule';
    case 'no-machine':
      return 'projects.schedule.paused.noMachine';
    case 'cli-too-old':
      return 'projects.schedule.paused.cliTooOld';
    default:
      return null;
  }
}

export type ScheduleErrorKey =
  | 'projects.schedule.errors.configSchedule'
  | 'projects.schedule.errors.noMachine'
  | 'projects.schedule.errors.invalid'
  | 'projects.errors.notFound'
  | 'auth.errors.unknown';

/** The message for a failed save or remove. */
export function scheduleErrorKey(
  status: number | undefined,
  code: string | undefined,
): ScheduleErrorKey {
  if (code === 'config-schedule') {
    return 'projects.schedule.errors.configSchedule';
  }
  if (code === 'no-machine') return 'projects.schedule.errors.noMachine';
  if (status === 404) return 'projects.errors.notFound';
  if (status === 400) return 'projects.schedule.errors.invalid';
  return 'auth.errors.unknown';
}

/** Stale rows first, then by name, so the broken ones lead. */
export function healthOrder<T extends { state: string; scenarioName: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const stale = Number(b.state === 'failed') - Number(a.state === 'failed');
    return stale !== 0 ? stale : a.scenarioName.localeCompare(b.scenarioName);
  });
}
