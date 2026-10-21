// UTC with a fixed locale, so the server render and the browser agree and
// hydration never mismatches on a date.
const formatter = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

export function formatDate(iso: string): string {
  return formatter.format(new Date(iso));
}
