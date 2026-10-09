import { publicationDraft, type PublicationMoment } from './calendar-publication.ts';
import { isSyncUuid } from './sync.ts';
export type AppleCalendarDraft = { title: string; location: string; start: PublicationMoment; end: PublicationMoment };
export type AppleCalendarFacts = { id: string; calendar_id: string; title: string; start: string; end: string; all_day: boolean; time_zone: string; url: string | null; recurring: boolean; cancelled: boolean };
export function appleCalendarUrl(planId: string, operationId: string) {
  if (!isSyncUuid(planId) || !isSyncUuid(operationId)) throw new Error('Choose a saved plan and calendar review.');
  return `bonds://calendar/apple/${planId}?receipt=${operationId}`;
}
export function appleCalendarDraft(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 || Object.keys(input).some((key) => !['title', 'location', 'start', 'end'].includes(key))) throw new Error('Review the event fields again.');
  const value = input as AppleCalendarDraft;
  const validated = publicationDraft({ summary: value.title, location: value.location, visibility: 'default', start: value.start, end: value.end, attendee_emails: [], follow_plan_date: false });
  const allDay = 'date' in validated.google.start;
  return { draft: { ...value, title: validated.google.summary, location: validated.google.location }, event: { title: validated.google.summary, location: validated.google.location,
    startDate: 'date' in validated.google.start ? validated.google.start.date + 'T00:00:00.000Z' : validated.google.start.dateTime,
    endDate: 'date' in validated.google.end ? validated.google.end.date + 'T00:00:00.000Z' : validated.google.end.dateTime,
    timeZone: 'date' in validated.google.start ? 'UTC' : validated.google.start.timeZone, allDay } };
}
export function readAppleCalendarFacts(input: unknown): AppleCalendarFacts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The selected Calendar event could not be verified.');
  const p = input as AppleCalendarFacts;
  for (const key of ['id', 'calendar_id', 'title', 'start', 'end', 'time_zone'] as const) if (typeof p[key] !== 'string' || p[key].length > (key === 'title' ? 500 : 1024) || /[\u0000-\u001f\u007f]/u.test(p[key])) throw new Error('The selected Calendar event could not be verified.');
  if (!p.id || !p.calendar_id || typeof p.all_day !== 'boolean' || typeof p.recurring !== 'boolean' || typeof p.cancelled !== 'boolean' || p.url !== null && (typeof p.url !== 'string' || p.url.length > 500)) throw new Error('The selected Calendar event could not be verified.');
  const start = Date.parse(p.start), end = Date.parse(p.end);
  for (const value of [p.start, p.end]) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
    if (!match || !Number.isFinite(Date.parse(value)) || new Date(match[1]).toISOString().slice(0, 10) !== match[1]
      || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || match[5] !== 'Z' && (+match[5].slice(1, 3) > 23 || +match[5].slice(4) > 59)) throw new Error('The selected event times could not be verified.');
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('The selected event times could not be verified.');
  let zone: string; try { zone = new Intl.DateTimeFormat('en', { timeZone: p.time_zone }).resolvedOptions().timeZone; if (/^[+-]/u.test(zone)) throw new Error(); } catch { throw new Error('The selected event timezone could not be verified.'); }
  return { id: p.id, calendar_id: p.calendar_id, title: p.title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), time_zone: zone,
    all_day: p.all_day, recurring: p.recurring, cancelled: p.cancelled, url: p.url };
}
export function appleCalendarDay(facts: AppleCalendarFacts) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: facts.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(facts.start));
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value])); return `${values.year}-${values.month}-${values.day}`;
}
