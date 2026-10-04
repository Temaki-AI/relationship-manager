import { readCalendarEventFacts, type EventMoment } from './calendar-events.ts';
import { isSyncUuid } from './sync.ts';
import { calendarContextIds, readSyncV4Record } from './sync-v4-client.ts';
import type { SyncV4EntityRecord } from './sync-v4.ts';

export type CalendarLinkMutation = {
  version: 1; operationId: string; epoch: string; eventId: string; baseFingerprint: string;
  contactIds: string[]; planIds: string[];
};
export type CalendarLinkAcknowledgement = {
  version: 1; operationId: string; epoch: string; event: SyncV4EntityRecord | null;
};
export class CalendarLinkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'invalid_links') { super(message); this.status = status; this.code = code; }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function readCalendarLinkMutation(value: unknown): CalendarLinkMutation {
  const keys = ['version', 'operationId', 'epoch', 'eventId', 'baseFingerprint', 'contactIds', 'planIds'];
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== 1 || !isSyncUuid(value.operationId) || !isSyncUuid(value.epoch) || !isSyncUuid(value.eventId)
    || typeof value.baseFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.baseFingerprint)) {
    throw new CalendarLinkError('Use the saved meeting and its reviewed people and plan choices.');
  }
  for (const key of ['contactIds', 'planIds']) {
    const ids = value[key];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !isSyncUuid(id)) || new Set(ids).size !== ids.length) {
      throw new CalendarLinkError('Choose at most 20 distinct people and 20 distinct plans.');
    }
  }
  return value as CalendarLinkMutation;
}

/** Hash JSON.stringify(input) with SHA-256 on both server and phone. Never put these facts in an outbox. */
export function calendarLinksFingerprintInput(value: unknown): unknown[] {
  const record = readSyncV4Record(value);
  if (record.entity !== 'source_event' || record.deleted || !record.data) throw new CalendarLinkError('This saved meeting is no longer available.', 409, 'event_missing');
  const data = record.data, facts = readCalendarEventFacts(JSON.parse(String(data.facts)));
  const moment = (p: EventMoment | null) => p ? [p.date, p.instant ? new Date(p.instant).toISOString() : p.date_time, p.time_zone] : null;
  const participants = facts.attendees.map((p) => [p.email, p.name, p.self, p.resource, p.organizer, p.response]);
  participants.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  // Observation age, grant status, display labels, provider etags and transport revisions do not change the reviewed meeting.
  return ['calendar-links-1', record.id, data.provider, data.calendar_time_zone,
    facts.id, facts.status, facts.title, facts.location, facts.visibility, facts.redacted, facts.event_type,
    moment(facts.start), moment(facts.end), moment(facts.original_start), facts.recurring_id, facts.ical_uid,
    facts.organizer ? [facts.organizer.email, facts.organizer.name, facts.organizer.self] : null,
    participants, facts.attendees_incomplete, facts.google_url, facts.conference_url,
    calendarContextIds(data.contact_ids).sort(), calendarContextIds(data.plan_ids).sort()];
}

export function readCalendarLinkAcknowledgement(value: unknown, mutation: CalendarLinkMutation): CalendarLinkAcknowledgement {
  if (!object(value) || Object.keys(value).length !== 4 || Object.keys(value).some((key) => !['version', 'operationId', 'epoch', 'event'].includes(key))
    || value.version !== 1 || value.operationId !== mutation.operationId || value.epoch !== mutation.epoch) {
    throw new CalendarLinkError('The server did not confirm these meeting choices. Retry the unchanged operation.', 502, 'invalid_ack');
  }
  const event = value.event === null ? null : readSyncV4Record(value.event);
  if (event && (event.entity !== 'source_event' || event.deleted || event.id !== mutation.eventId)) {
    throw new CalendarLinkError('The server returned another meeting. Keep your choices and retry.', 502, 'invalid_ack');
  }
  return { version: 1, operationId: mutation.operationId, epoch: mutation.epoch, event };
}
