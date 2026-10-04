import type { CalendarFacts, CalendarDiscoveryRun } from './calendars.ts';
import { calendarIdentifier } from './calendars.ts';

export type EventMoment = { date: string | null; date_time: string | null; time_zone: string | null; instant: string | null };
export type EventParticipant = { email: string | null; name: string | null; self: boolean; resource: boolean; organizer: boolean; response: 'needsAction' | 'declined' | 'tentative' | 'accepted' };
export type CalendarEventFacts = {
  id: string; status: 'confirmed' | 'tentative' | 'cancelled'; title: string; location: string | null;
  visibility: 'default' | 'public' | 'private' | 'confidential'; redacted: boolean; event_type: string;
  start: EventMoment | null; end: EventMoment | null; original_start: EventMoment | null;
  recurring_id: string | null; ical_uid: string | null; updated: string | null; etag: string | null;
  organizer: { email: string | null; name: string | null; self: boolean } | null;
  attendees: EventParticipant[]; attendees_incomplete: boolean; google_url: string | null; conference_url: string | null;
};
export type CalendarEventsReview = {
  epoch: string; authorization_revision: number; selection_revision: number; calendar: CalendarFacts;
  availability: 'available' | 'unavailable'; can_download: boolean; generation: string | null; last_downloaded_at: string | null;
  window_start: string | null; window_end: string | null; events: CalendarEventFacts[];
  more: boolean; next: string | null; run: CalendarDiscoveryRun | null;
  schedule: { enabled: boolean; interval: 3600 | 86400; revision: number; past_days: number; future_days: number; next_at: number | null };
};

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid saved event details.');
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, nullable = false) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid saved event text.');
}
function timezone(value: unknown) { string(value, 100); try { new Intl.DateTimeFormat('en', { timeZone: value as string }); } catch { throw new Error('Invalid saved event timezone.'); } }
function readMoment(value: unknown): EventMoment | null {
  if (value === null) return null;
  const p = fields(value, ['date', 'date_time', 'time_zone', 'instant']);
  if (p.time_zone !== null) timezone(p.time_zone);
  if (p.date !== null) {
    if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(p.date) || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().slice(0, 10) !== p.date || p.date_time !== null || p.instant !== null) throw new Error('Invalid saved all-day date.');
  } else {
    if (typeof p.date_time !== 'string' || p.date_time.length > 80 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(p.date_time)
      || +p.date_time.slice(11, 13) > 23 || +p.date_time.slice(14, 16) > 59 || +p.date_time.slice(17, 19) > 59) throw new Error('Invalid saved event time.');
    const day = p.date_time.slice(0, 10); if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('Invalid saved event date.');
    const offset = /(?:Z|[+-]\d{2}:\d{2})$/u.test(p.date_time);
    if (!offset && p.time_zone === null || p.instant !== null && (typeof p.instant !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(p.instant) || !Number.isFinite(Date.parse(p.instant)))) throw new Error('Invalid saved event offset.');
    if (offset && (p.instant === null || Date.parse(p.date_time) !== Date.parse(p.instant as string))) throw new Error('Inconsistent saved event instant.');
    if (!offset && p.instant !== null) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: p.time_zone as string, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(p.instant as string)).map((p) => [p.type, p.value]));
      if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` !== p.date_time.slice(0, 19)) throw new Error('Inconsistent saved local time.');
    }
  }
  return p as EventMoment;
}
function email(value: unknown) { string(value, 320, true); if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value as string)) throw new Error('Invalid saved participant address.'); }
function url(value: unknown, googleOnly = false) { if (value === null) return; string(value, 2048); const u = new URL(value as string); if (u.protocol !== 'https:' || u.username || u.password || googleOnly && !['calendar.google.com', 'www.google.com'].includes(u.hostname)) throw new Error('Invalid saved event link.'); }
export function readCalendarEventFacts(value: unknown): CalendarEventFacts {
  const e = fields(value, ['id', 'status', 'title', 'location', 'visibility', 'redacted', 'event_type', 'start', 'end', 'original_start', 'recurring_id', 'ical_uid', 'updated', 'etag', 'organizer', 'attendees', 'attendees_incomplete', 'google_url', 'conference_url']);
  calendarIdentifier(e.id); string(e.title, 500); string(e.location, 500, true); string(e.event_type, 80);
  for (const key of ['ical_uid', 'etag']) string(e[key], 1024, true); string(e.updated, 80, true);
  if (e.recurring_id !== null) calendarIdentifier(e.recurring_id);
  if (typeof e.status !== 'string' || !['confirmed', 'tentative', 'cancelled'].includes(e.status) || typeof e.visibility !== 'string' || !['default', 'public', 'private', 'confidential'].includes(e.visibility) || typeof e.redacted !== 'boolean' || typeof e.attendees_incomplete !== 'boolean') throw new Error('Invalid saved event status.');
  const start = readMoment(e.start), end = readMoment(e.end), original = readMoment(e.original_start);
  if (e.status !== 'cancelled' && (!start || !end || Boolean(start.date) !== Boolean(end.date) || start.date && end.date! <= start.date || start.instant && end.instant && Date.parse(end.instant) <= Date.parse(start.instant)) || e.recurring_id && !original) throw new Error('Invalid saved event interval.');
  if (!Array.isArray(e.attendees) || e.attendees.length > 100) throw new Error('Oversized saved participant list.');
  for (const raw of e.attendees) { const p = fields(raw, ['email', 'name', 'self', 'resource', 'organizer', 'response']); email(p.email); string(p.name, 200, true); if (['self', 'resource', 'organizer'].some((key) => typeof p[key] !== 'boolean') || typeof p.response !== 'string' || !['needsAction', 'declined', 'tentative', 'accepted'].includes(p.response)) throw new Error('Invalid saved participant.'); }
  if (e.organizer !== null) { const p = fields(e.organizer, ['email', 'name', 'self']); email(p.email); string(p.name, 200, true); if (typeof p.self !== 'boolean') throw new Error('Invalid saved organizer.'); }
  url(e.google_url, true); url(e.conference_url);
  if (e.redacted !== ['private', 'confidential'].includes(String(e.visibility)) || e.redacted && (e.title !== 'Busy' || e.location !== null || e.organizer !== null || e.attendees.length !== 0 || e.attendees_incomplete || e.ical_uid !== null || e.google_url !== null || e.conference_url !== null || e.event_type !== 'default')) throw new Error('Private event details must be redacted.');
  if (new TextEncoder().encode(JSON.stringify(e)).byteLength > 65536) throw new Error('Oversized saved event.');
  return e as CalendarEventFacts;
}
export type SavedCalendarEvent = { public_id: string; revision: number; calendar_label: string; calendar_time_zone: string; account_email: string;
  observed_at: string; source_status: 'available' | 'unavailable' | 'review_required'; facts: CalendarEventFacts;
  people: Array<{ id: number; name: string }>; plans: Array<{ id: number; summary: string; contact_id: number; contact_name: string; planned_date: string }> };

export type CalendarEventDirectory = {
  contacts: Array<{ id: number; name: string; email: string | null }>;
  plans: SavedCalendarEvent['plans'];
  contacts_more: boolean; contacts_next: number | null; plans_more: boolean; plans_next: number | null;
};
export type CalendarEventLinkPreview = CalendarEventDirectory & {
  epoch: string; authorization_revision: number; selection_revision: number; generation: string;
  calendar_label: string; calendar_time_zone: string; account_email: string; observed_at: string;
  facts: CalendarEventFacts; saved: SavedCalendarEvent | null;
  matches: Array<{ address: string; candidates: CalendarEventDirectory['contacts']; more: boolean }>;
};
export type SavedCalendarEventReview = CalendarEventDirectory & { epoch: string; event: SavedCalendarEvent };
