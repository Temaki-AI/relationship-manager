import { calendarIdentifier } from '@/packages/domain/src/calendars';
import { readCalendarEventFacts, type CalendarEventFacts, type EventMoment, type EventParticipant } from '@/packages/domain/src/calendar-events';
import { dateInTimeZone, startOfCivilDayUTC } from '@/lib/civil-date';
import { ProviderConnectionError } from './provider-vault';
import type { ProviderFetch } from './google-provider';
import { googleCalendarResponseJson } from './google-calendars';

export class GoogleEventsError extends ProviderConnectionError {
  constructor(readonly reason: 'permission' | 'unavailable' | 'retry' | 'invalid', readonly retryAfter = 30) {
    super(reason === 'permission' ? 'Reconnect Google Calendar to read events.' : reason === 'unavailable' ? 'Event access to this calendar is unavailable. The last complete download was kept.'
      : reason === 'retry' ? 'Google Calendar is unavailable or limiting requests. Try again shortly.' : 'This event download could not be completed. The last complete download was kept.', reason === 'retry' ? 503 : reason === 'invalid' ? 502 : 409);
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleEventsError('invalid'); return value as Record<string, unknown>; }
function text(value: unknown, maximum: number, fallback: string | null = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new GoogleEventsError('invalid');
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) || fallback;
}
function flag(value: unknown) { if (value !== undefined && typeof value !== 'boolean') throw new GoogleEventsError('invalid'); return value === true; }
function zone(value: unknown) { if (typeof value !== 'string' || !value || value.length > 100) throw new GoogleEventsError('invalid'); try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new GoogleEventsError('invalid'); } return value; }
function day(value: unknown) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new GoogleEventsError('invalid'); return value; }
function wallTime(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function moment(value: unknown, fallbackZone: string): EventMoment {
  const item = object(value), timeZone = item.timeZone === undefined ? null : zone(item.timeZone);
  if (item.date !== undefined) {
    if (item.dateTime !== undefined) throw new GoogleEventsError('invalid');
    return { date: day(item.date), date_time: null, time_zone: timeZone, instant: null };
  }
  const raw = item.dateTime;
  if (typeof raw !== 'string' || raw.length > 80 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(raw)) throw new GoogleEventsError('invalid');
  day(raw.slice(0, 10));
  if (+raw.slice(11, 13) > 23 || +raw.slice(14, 16) > 59 || +raw.slice(17, 19) > 59) throw new GoogleEventsError('invalid');
  let instant: string | null = null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) {
    const parsed = Date.parse(raw); if (!Number.isFinite(parsed)) throw new GoogleEventsError('invalid'); instant = new Date(parsed).toISOString();
  } else {
    // Google permits wall time plus IANA zone. Never invent an offset for a fold.
    if (!timeZone) throw new GoogleEventsError('invalid');
    const center = Date.parse(raw + 'Z'), offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 12) { const sample = center + hours * 3_600_000; offsets.add(Date.parse(wallTime(sample, timeZone) + 'Z') - Math.floor(sample / 1000) * 1000); }
    const candidates = [...offsets].map((offset) => center - offset).filter((candidate) => wallTime(candidate, timeZone) === raw.slice(0, 19));
    if (candidates.length === 0) throw new GoogleEventsError('invalid');
    if (candidates.length === 1) instant = new Date(candidates[0]).toISOString();
  }
  return { date: null, date_time: raw, time_zone: timeZone ?? fallbackZone, instant };
}
function email(value: unknown) { const result = text(value, 320); if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) throw new GoogleEventsError('invalid'); return result; }
function link(value: unknown, googleOnly = false) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) throw new GoogleEventsError('invalid');
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!googleOnly || ['calendar.google.com', 'www.google.com'].includes(url.hostname)) ? url.href : null; } catch { return null; }
}
export function normalizeGoogleEvent(raw: unknown, timeZone: string): CalendarEventFacts {
  const item = object(raw), id = calendarIdentifier(item.id), status = item.status ?? 'confirmed', visibility = item.visibility ?? 'default';
  if (typeof status !== 'string' || !['confirmed', 'tentative', 'cancelled'].includes(status) || typeof visibility !== 'string' || !['default', 'public', 'private', 'confidential'].includes(visibility)) throw new GoogleEventsError('invalid');
  const redacted = visibility === 'private' || visibility === 'confidential', cancelled = status === 'cancelled';
  const start = item.start ? moment(item.start, timeZone) : null, end = item.end ? moment(item.end, timeZone) : null;
  if (!cancelled && (!start || !end || Boolean(start.date) !== Boolean(end.date) || start.date && end.date! <= start.date || start.instant && end.instant && end.instant <= start.instant)) throw new GoogleEventsError('invalid');
  const recurringId = item.recurringEventId === undefined ? null : calendarIdentifier(item.recurringEventId), original = item.originalStartTime ? moment(item.originalStartTime, timeZone) : null;
  if (recurringId && !original) throw new GoogleEventsError('invalid');
  let attendees: EventParticipant[] = [], organizer: CalendarEventFacts['organizer'] = null, conference: string | null = null;
  if (!redacted && !cancelled) {
    if (item.attendees !== undefined && (!Array.isArray(item.attendees) || item.attendees.length > 100)) throw new GoogleEventsError('invalid');
    attendees = ((item.attendees ?? []) as unknown[]).map((raw) => { const p = object(raw), response = p.responseStatus ?? 'needsAction'; if (typeof response !== 'string' || !['needsAction', 'declined', 'tentative', 'accepted'].includes(response)) throw new GoogleEventsError('invalid');
      return { email: email(p.email), name: text(p.displayName, 200), self: flag(p.self), resource: flag(p.resource), organizer: flag(p.organizer), response: response as EventParticipant['response'] }; });
    if (item.organizer) { const p = object(item.organizer); organizer = { email: email(p.email), name: text(p.displayName, 200), self: flag(p.self) }; }
    conference = link(item.hangoutLink);
    if (!conference && item.conferenceData) { const data = object(item.conferenceData); if (data.entryPoints !== undefined && (!Array.isArray(data.entryPoints) || data.entryPoints.length > 20)) throw new GoogleEventsError('invalid');
      for (const raw of (data.entryPoints ?? []) as unknown[]) { const p = object(raw); if (p.entryPointType === 'video') { conference = link(p.uri); if (conference) break; } } }
  }
  const facts: CalendarEventFacts = { id, status: status as CalendarEventFacts['status'], visibility: visibility as CalendarEventFacts['visibility'], redacted,
    title: redacted ? 'Busy' : cancelled ? 'Cancelled event' : text(item.summary, 500, 'Untitled event')!, location: redacted || cancelled ? null : text(item.location, 500),
    event_type: redacted ? 'default' : text(item.eventType, 80, 'default')!, start, end, original_start: original, recurring_id: recurringId,
    ical_uid: redacted ? null : text(item.iCalUID, 1024), updated: text(item.updated, 80), etag: text(item.etag, 1024), organizer, attendees,
    attendees_incomplete: redacted || cancelled ? false : flag(item.attendeesOmitted), google_url: redacted || cancelled ? null : link(item.htmlLink, true), conference_url: conference };
  try { return readCalendarEventFacts(facts); } catch { throw new GoogleEventsError('invalid'); }
}
export function eventSortKey(event: CalendarEventFacts, timeZone: string) {
  const point = event.start ?? event.original_start; return point?.date ? point.date + 'T00:00:00' : point?.instant ? wallTime(Date.parse(point.instant), timeZone) : point?.date_time?.slice(0, 19) ?? '9999-12-31T23:59:59';
}
export function calendarDownloadWindow(timeZone: string, past: unknown, future: unknown, now = new Date()) {
  zone(timeZone);
  if (!Number.isInteger(past) || !Number.isInteger(future) || (past as number) < 0 || (future as number) < 0 || (past as number) + (future as number) > 365) throw new ProviderConnectionError('Choose whole days with at most 365 past and future days combined, plus today.', 400);
  const today = dateInTimeZone(now, timeZone)!;
  const shift = (days: number) => new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  return { start: startOfCivilDayUTC(shift(-(past as number)), timeZone), end: startOfCivilDayUTC(shift((future as number) + 1), timeZone) };
}
export async function googleEventsPage(token: string, calendarId: string, timeZone: string, windowStart: string, windowEnd: string, pageToken: string | null, fetcher: ProviderFetch = fetch) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarIdentifier(calendarId)) + '/events');
  for (const [key, value] of Object.entries({ maxResults: '50', maxAttendees: '100', singleEvents: 'true', showDeleted: 'true', timeZone: zone(timeZone), timeMin: windowStart, timeMax: windowEnd,
    fields: 'accessRole,timeZone,nextPageToken,items(id,status,summary,location,visibility,eventType,start,end,recurringEventId,originalStartTime,iCalUID,updated,etag,organizer(email,displayName,self),attendees(email,displayName,self,resource,organizer,responseStatus),attendeesOmitted,htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri)))' })) url.searchParams.set(key, value);
  if (pageToken) { if (pageToken.length > 8192 || /[\u0000-\u0020\u007f]/u.test(pageToken)) throw new GoogleEventsError('invalid'); url.searchParams.set('pageToken', pageToken); }
  let response: Response; try { response = await fetcher(url.href, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { throw new GoogleEventsError('retry'); }
  const retryAfter = Number(response.headers.get('Retry-After')), retry = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(2, Math.min(900, retryAfter)) : 30;
  if (response.status === 401) throw new GoogleEventsError('permission'); if (response.status === 404) throw new GoogleEventsError('unavailable');
  if (response.status >= 500 || response.status === 429) throw new GoogleEventsError('retry', retry);
  let value: Record<string, unknown>; try { value = await googleCalendarResponseJson(response, 2 * 1024 * 1024); } catch { throw new GoogleEventsError('invalid'); }
  if (!response.ok) {
    const error = value.error ? object(value.error) : {}, reasons = [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])].map((raw) => object(raw).reason);
    if (reasons.some((r) => ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions'].includes(String(r)))) throw new GoogleEventsError('permission');
    if (reasons.some((r) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(String(r)))) throw new GoogleEventsError('retry', retry);
    if (response.status === 403) throw new GoogleEventsError('unavailable'); throw new GoogleEventsError('invalid');
  }
  if (value.accessRole !== undefined && !['owner', 'writer', 'writerWithoutPrivateAccess', 'reader'].includes(String(value.accessRole))) throw new GoogleEventsError('unavailable');
  if (value.items !== undefined && (!Array.isArray(value.items) || value.items.length > 50)) throw new GoogleEventsError('invalid');
  const next = value.nextPageToken ?? null;
  if (next !== null && (typeof next !== 'string' || !next || next.length > 8192 || /[\u0000-\u0020\u007f]/u.test(next))) throw new GoogleEventsError('invalid');
  let events: CalendarEventFacts[];
  try { events = ((value.items ?? []) as unknown[]).map((raw) => normalizeGoogleEvent(raw, timeZone)); } catch { throw new GoogleEventsError('invalid'); }
  if (new Set(events.map((event) => event.id)).size !== events.length) throw new GoogleEventsError('invalid');
  return { events, next: next as string | null };
}
