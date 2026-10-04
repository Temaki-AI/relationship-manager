import type Database from 'better-sqlite3';
import { parseDateOnly } from './relationship-validation.ts';
import { birthdayMatchesDaySQL, dateInTimeZone, normalizeTimeZone } from './civil-date.ts';
import type { CalendarDisplayFacts } from '../packages/domain/src/calendar-event-display.ts';
import type { SavedCalendarEvent } from '../packages/domain/src/calendar-events.ts';

export const MAX_CALENDAR_RANGE_DAYS = 62;
export const MAX_CALENDAR_EVENTS = 5_000;

export type CalendarEventKind = 'birthday' | 'reminder' | 'plan' | 'interaction' | 'source_event';

export type CoreCalendarEvent = {
  id: string;
  kind: Exclude<CalendarEventKind, 'source_event'>;
  date: string;
  starts_at: string | null;
  title: string;
  detail: string | null;
  contact_id: number;
  contact_name: string;
  completed: boolean;
  source_id: number;
  subtype: string;
};

export type CalendarEventCardContext = Pick<SavedCalendarEvent, 'public_id' | 'calendar_label' | 'calendar_time_zone' | 'account_email' | 'observed_at' | 'source_status' | 'people' | 'plans'> & { facts: CalendarDisplayFacts };
export type SourceCalendarEvent = Omit<CoreCalendarEvent, 'kind' | 'contact_id' | 'source_id' | 'completed'> & {
  kind: 'source_event'; contact_id: null; source_id: null; completed: false;
  last_date: string; source: CalendarEventCardContext;
};
export type CalendarEvent = CoreCalendarEvent | SourceCalendarEvent;

export function calendarEventPeople(event: CalendarEvent): Array<{ id: number; name: string }> {
  if (event.kind !== 'source_event') return [{ id: event.contact_id, name: event.contact_name }];
  return [...new Map([...event.source.people, ...event.source.plans.map((plan) => ({ id: plan.contact_id, name: plan.contact_name }))].map((person) => [person.id, person])).values()];
}

/** Expand only inside the requested grid; the agenda keeps one card per saved meeting. */
export function calendarEventDates(event: CalendarEvent, range: { start: string; end: string }): string[] {
  const first = event.date < range.start ? range.start : event.date;
  const last = event.kind === 'source_event' ? event.last_date : event.date;
  const end = last > range.end ? range.end : last;
  const dates: string[] = [];
  for (let value = Date.parse(first + 'T12:00:00Z'), stop = Date.parse(end + 'T12:00:00Z'); value <= stop && dates.length < MAX_CALENDAR_RANGE_DAYS; value += 86_400_000) dates.push(new Date(value).toISOString().slice(0, 10));
  return dates;
}

export class CalendarRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarRangeError';
  }
}

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

export function normalizeCalendarRange(startValue: unknown, endValue: unknown): {
  start: string;
  end: string;
} {
  const start = parseDateOnly(startValue);
  const end = parseDateOnly(endValue);
  if (!start || !end) throw new CalendarRangeError('Valid start and end dates are required.');
  const rangeDays = dayNumber(end) - dayNumber(start) + 1;
  if (rangeDays < 1) throw new CalendarRangeError('The calendar end date must not precede its start date.');
  if (rangeDays > MAX_CALENDAR_RANGE_DAYS) {
    throw new CalendarRangeError(`Calendar ranges are limited to ${MAX_CALENDAR_RANGE_DAYS} days.`);
  }
  return { start, end };
}

type BirthdayRow = {
  source_id: number;
  contact_id: number;
  contact_name: string;
  birthday_name: string;
  date: string;
  subtype: 'contact' | 'child';
};

type ReminderRow = {
  source_id: number;
  contact_id: number;
  contact_name: string;
  title: string;
  detail: string | null;
  starts_at: string;
  completed_at: string | null;
};

type DateOnlyRow = {
  source_id: number;
  contact_id: number;
  contact_name: string;
  date: string;
  title: string | null;
  detail: string | null;
  subtype: string;
  completed_at?: string | null;
};

export function listCalendarEvents(
  db: Database.Database,
  options: { start: unknown; end: unknown; timeZone?: unknown }
): { events: CalendarEvent[]; range: { start: string; end: string }; truncated: boolean } {
  const range = normalizeCalendarRange(options.start, options.end);
  const timeZone = normalizeTimeZone(options.timeZone);
  const birthdays = db.prepare(`
    WITH RECURSIVE calendar_days(date) AS (
      VALUES (?)
      UNION ALL
      SELECT date(date, '+1 day') FROM calendar_days WHERE date < ?
    )
    SELECT
      contacts.id AS source_id,
      contacts.id AS contact_id,
      contacts.name AS contact_name,
      contacts.name AS birthday_name,
      calendar_days.date,
      'contact' AS subtype
    FROM calendar_days
    JOIN contacts ON contacts.birthday IS NOT NULL
      AND ${birthdayMatchesDaySQL('contacts.birthday', 'calendar_days.date')}
    UNION ALL
    SELECT
      children.id AS source_id,
      children.contact_id,
      contacts.name AS contact_name,
      children.name AS birthday_name,
      calendar_days.date,
      'child' AS subtype
    FROM calendar_days
    JOIN contact_children children ON children.linked_contact_id IS NULL AND children.birthday IS NOT NULL
      AND ${birthdayMatchesDaySQL('children.birthday', 'calendar_days.date')}
    JOIN contacts ON contacts.id = children.contact_id
  `).all(range.start, range.end) as BirthdayRow[];

  const reminders = db.prepare(`
    SELECT
      reminders.id AS source_id,
      reminders.contact_id,
      contacts.name AS contact_name,
      reminders.title,
      reminders.notes AS detail,
      reminders.remind_at AS starts_at,
      reminders.completed_at
    FROM reminders
    JOIN contacts ON contacts.id = reminders.contact_id
    WHERE julianday(reminders.remind_at) >= julianday(?, '-1 day')
      AND julianday(reminders.remind_at) < julianday(?, '+2 days')
    ORDER BY julianday(reminders.remind_at), reminders.id
  `).all(range.start, range.end) as ReminderRow[];

  const plans = db.prepare(`
    SELECT
      plans.id AS source_id,
      plans.contact_id,
      contacts.name AS contact_name,
      plans.planned_date AS date,
      plans.summary AS title,
      plans.notes AS detail,
      plans.type AS subtype,
      plans.completed_at
    FROM plans
    JOIN contacts ON contacts.id = plans.contact_id
    WHERE plans.planned_date BETWEEN ? AND ?
    ORDER BY plans.planned_date, plans.id
  `).all(range.start, range.end) as DateOnlyRow[];

  const interactions = db.prepare(`
    SELECT
      interactions.id AS source_id,
      interactions.contact_id,
      contacts.name AS contact_name,
      interactions.date,
      interactions.summary AS title,
      interactions.notes AS detail,
      interactions.type AS subtype
    FROM interactions
    JOIN contacts ON contacts.id = interactions.contact_id
    WHERE interactions.date BETWEEN ? AND ?
    ORDER BY interactions.date, interactions.id
  `).all(range.start, range.end) as DateOnlyRow[];

  const events: CalendarEvent[] = birthdays.map((row) => ({
    id: `birthday-${row.subtype}-${row.source_id}-${row.date.slice(0, 4)}`,
    kind: 'birthday',
    date: row.date,
    starts_at: null,
    title: row.subtype === 'child' ? `${row.birthday_name}'s birthday` : `${row.birthday_name}'s birthday`,
    detail: row.subtype === 'child' ? `Child of ${row.contact_name}` : 'Birthday',
    contact_id: row.contact_id,
    contact_name: row.contact_name,
    completed: false,
    source_id: row.source_id,
    subtype: row.subtype,
  }));

  for (const row of reminders) {
    const date = dateInTimeZone(row.starts_at, timeZone);
    if (!date || date < range.start || date > range.end) continue;
    events.push({
      id: `reminder-${row.source_id}`,
      kind: 'reminder',
      date,
      starts_at: row.starts_at,
      title: row.title,
      detail: row.detail,
      contact_id: row.contact_id,
      contact_name: row.contact_name,
      completed: Boolean(row.completed_at),
      source_id: row.source_id,
      subtype: 'reminder',
    });
  }

  for (const row of plans) {
    events.push({
      id: `plan-${row.source_id}`,
      kind: 'plan',
      date: row.date,
      starts_at: null,
      title: row.title || `${row.subtype} with ${row.contact_name}`,
      detail: row.detail,
      contact_id: row.contact_id,
      contact_name: row.contact_name,
      completed: Boolean(row.completed_at),
      source_id: row.source_id,
      subtype: row.subtype,
    });
  }

  for (const row of interactions) {
    events.push({
      id: `interaction-${row.source_id}`,
      kind: 'interaction',
      date: row.date,
      starts_at: null,
      title: row.title || `${row.subtype} with ${row.contact_name}`,
      detail: row.detail,
      contact_id: row.contact_id,
      contact_name: row.contact_name,
      completed: true,
      source_id: row.source_id,
      subtype: row.subtype,
    });
  }

  events.sort((left, right) => (
    left.date.localeCompare(right.date)
    || (left.starts_at || '').localeCompare(right.starts_at || '')
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
  ));
  return {
    events: events.slice(0, MAX_CALENDAR_EVENTS),
    range,
    truncated: events.length > MAX_CALENDAR_EVENTS,
  };
}
