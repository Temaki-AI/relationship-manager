export type PublicationMoment = { date: string | null; date_time: string | null; time_zone: string | null };
export type PublicationDraft = { summary: string; location: string; visibility: 'default' | 'public' | 'private' | 'confidential'; start: PublicationMoment; end: PublicationMoment; attendee_emails: string[]; follow_plan_date: boolean };
type GoogleMoment = { date: string } | { dateTime: string; timeZone: string };
function exact(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Review the event fields again.');
  return value as Record<string, unknown>;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Choose a valid event date.');
  return value;
}
function wall(instant: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map((part) => [part.type, part.value]));
  return [p.year, p.month, p.day].join('-') + 'T' + [p.hour, p.minute, p.second].join(':');
}
function moment(value: unknown): { google: GoogleMoment; instant: number | null; day: string } {
  const p = exact(value, ['date', 'date_time', 'time_zone']);
  if (p.date !== null) {
    if (p.date_time !== null || p.time_zone !== null) throw new Error('An all-day event uses dates only.');
    return { google: { date: date(p.date) }, instant: null, day: p.date as string };
  }
  if (typeof p.date_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/u.test(p.date_time)
    || +p.date_time.slice(11, 13) > 23 || +p.date_time.slice(14, 16) > 59 || +p.date_time.slice(17, 19) > 59 || typeof p.time_zone !== 'string' || p.time_zone.length > 100) throw new Error('Choose valid event times and a timezone name.');
  date(p.date_time.slice(0, 10));
  let zone: string;
  try { zone = new Intl.DateTimeFormat('en', { timeZone: p.time_zone }).resolvedOptions().timeZone; if (/^[+-]/u.test(zone)) throw new Error(); } catch { throw new Error('Choose a timezone name, such as Europe/Lisbon.'); }
  const raw = p.date_time, local = raw.slice(0, 19), center = Date.parse(local + 'Z');
  let instant: number;
  if (raw.length > 19) {
    instant = Date.parse(raw);
    if (!Number.isFinite(instant) || wall(instant, zone) !== local) throw new Error('The UTC offset does not match this local time and timezone.');
  } else {
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 12) { const sample = center + hours * 3_600_000; offsets.add(Date.parse(wall(sample, zone) + 'Z') - sample); }
    const matches = [...offsets].map((offset) => center - offset).filter((candidate) => wall(candidate, zone) === local);
    if (matches.length === 0) throw new Error('This local time does not exist because the clocks change. Choose another time.');
    if (matches.length !== 1) throw new Error('This local time occurs twice. Add its UTC offset, such as +01:00 or +00:00, before publishing.');
    instant = matches[0];
  }
  return { google: { dateTime: new Date(instant).toISOString(), timeZone: zone }, instant, day: local.slice(0, 10) };
}
export function publicationDraft(value: unknown) {
  const p = exact(value, ['summary', 'location', 'visibility', 'start', 'end', 'attendee_emails', 'follow_plan_date']);
  for (const key of ['summary', 'location']) if (typeof p[key] !== 'string' || (p[key] as string).length > 500 || /[\u0000-\u001f\u007f]/u.test(p[key] as string)) throw new Error('Event title and location must be at most 500 characters.');
  if (!(p.summary as string).trim() || !['default', 'public', 'private', 'confidential'].includes(String(p.visibility)) || typeof p.follow_plan_date !== 'boolean') throw new Error('Review the title, visibility and plan-date choice.');
  if (!Array.isArray(p.attendee_emails) || p.attendee_emails.length > 20 || p.attendee_emails.some((email) => typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))) throw new Error('Choose at most 20 valid invitee email addresses.');
  const emails = p.attendee_emails.map((email: string) => email.toLowerCase()).sort();
  if (new Set(emails).size !== emails.length) throw new Error('Choose each invitee once.');
  const start = moment(p.start), end = moment(p.end);
  if ((start.instant === null) !== (end.instant === null) || (start.instant === null ? end.day <= start.day : end.instant! <= start.instant)) throw new Error('The event end must be after its start, using the same date type.');
  if (start.instant !== null && end.instant! - start.instant > 366 * 86_400_000 || start.instant === null && Date.parse(end.day) - Date.parse(start.day) > 366 * 86_400_000) throw new Error('Choose an event lasting no more than one year.');
  return { draft: p as PublicationDraft, google: { summary: (p.summary as string).trim(), location: (p.location as string).trim(), visibility: p.visibility as 'default' | 'public' | 'private' | 'confidential',
    start: start.google, end: end.google, attendees: emails.map((email) => ({ email })) }, planDate: start.day };
}
