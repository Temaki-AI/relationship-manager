import type { CalendarEventFacts, EventMoment } from './calendar-events.ts';

export type CalendarDisplayFacts = Pick<CalendarEventFacts, 'title' | 'status' | 'start' | 'end' | 'original_start' | 'recurring_id' | 'redacted' | 'location' | 'google_url' | 'conference_url'>;

/** Only a supplied instant can be placed on a viewer's local day. All-day dates stay civil. */
export function calendarEventDayRange(facts: Pick<CalendarEventFacts, 'start' | 'end' | 'original_start'>, viewerZone: string): { first: string; last: string } | null {
  const start = facts.start ?? facts.original_start;
  if (!start) return null;
  if (start.date) {
    const end = facts.end?.date;
    const last = end && end > start.date ? new Date(Date.parse(end + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10) : start.date;
    return { first: start.date, last };
  }
  if (!start.instant) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: viewerZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (value: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const first = Date.parse(start.instant), end = facts.end?.instant ? Date.parse(facts.end.instant) : first;
  return { first: day(first), last: day(end > first ? end - 1 : first) };
}

/** Display all-day dates as civil dates; timed endpoints retain their source zone and offset. */
export function calendarEventWhen(facts: Pick<CalendarEventFacts, 'start' | 'end'> & Partial<Pick<CalendarEventFacts, 'original_start'>>, calendarZone: string, locale?: string) {
  const start = facts.start ?? facts.original_start ?? null, { end } = facts;
  if (start?.date) {
    const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'));
    const last = end?.date ? new Date(end.date + 'T12:00:00Z') : null;
    if (last) last.setUTCDate(last.getUTCDate() - 1);
    const final = last?.toISOString().slice(0, 10);
    return `${date(start.date)}${final && final > start.date ? ' – ' + date(final) : ''} · All day`;
  }
  if (!start?.instant) return start?.date_time ? `${start.date_time.replace('T', ' ')} (${start.time_zone ?? calendarZone}; offset not supplied)` : 'Date unavailable';
  function moment(value: EventMoment) {
    const timeZone = value.time_zone ?? calendarZone, instant = new Date(value.instant!);
    const text = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(instant);
    const offset = new Intl.DateTimeFormat('en', { hour: 'numeric', timeZoneName: 'shortOffset', timeZone }).formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value;
    return `${text} (${timeZone}${offset ? ', ' + offset : ''})`;
  }
  return `${moment(start)}${end?.instant ? ' – ' + moment(end) : ''}`;
}
