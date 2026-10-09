import type { SQLiteDatabase } from 'expo-sqlite';
import { readCalendarEventFacts, type CalendarEventFacts } from '../../../../packages/domain/src/calendar-events';
import { readSyncV4Record, calendarContextIds } from '../../../../packages/domain/src/sync-v4-client';
import type { SyncV4EntityRecord } from '../../../../packages/domain/src/sync-v4';
import { canonicalContactId } from './contact-aliases';
import type { ContextRecord } from './context';

export type NativeCalendarEvent = {
  id: string; facts: CalendarEventFacts; accountEmail: string; calendarLabel: string; timeZone: string;
  observedAt: string; sourceStatus: 'available' | 'unavailable' | 'review_required';
  linksState: 'pending' | 'conflict' | null;
  people: { id: string; name: string }[];
  plans: { id: string; summary: string; contactId: string; contactName: string; completed: boolean }[];
};
export type AgendaEntry = { kind: 'plan'; record: ContextRecord } | { kind: 'source_event'; event: NativeCalendarEvent };

export async function applyRemoteCalendarEvent(db: SQLiteDatabase, value: SyncV4EntityRecord) {
  const record = readSyncV4Record(value);
  if (record.entity !== 'source_event') throw new Error('Expected saved Calendar context.');
  if (record.deleted) { await db.runAsync('DELETE FROM calendar_events WHERE id = ? AND revision <= ?', record.id, record.revision); return; }
  const facts = readCalendarEventFacts(JSON.parse(String(record.data!.facts)));
  // All-day date is a display-order anchor, never a notification or invented meeting time.
  const anchor = facts.start ?? facts.original_start;
  const sort = anchor?.instant ?? (anchor?.date ? `${anchor.date}T00:00:00.000Z` : '~');
  await db.runAsync(`INSERT INTO calendar_events (id, revision, sort_at, record_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, sort_at = excluded.sort_at, record_json = excluded.record_json
    WHERE excluded.revision >= calendar_events.revision`, record.id, record.revision, sort, JSON.stringify(record));
}
export async function projectCalendarEvent(db: SQLiteDatabase, raw: string, overlay = true): Promise<NativeCalendarEvent> {
  const record = readSyncV4Record(JSON.parse(raw)), data = record.data!;
  if (record.entity !== 'source_event' || record.deleted) throw new Error('Unavailable saved Calendar context.');
  const intent = overlay ? await db.getFirstAsync<{ contact_ids: string; plan_ids: string; status: 'pending' | 'conflict' }>('SELECT contact_ids, plan_ids, status FROM calendar_event_link_queue WHERE event_id = ?', record.id) : null;
  const [linkedPeople, linkedPlans] = await Promise.all([
    db.getAllAsync<{ id: string; name: string }>(`SELECT COALESCE(a.canonical_id, link.value) id, COALESCE(c.name, 'Unavailable person') name
      FROM json_each(?) link LEFT JOIN contact_aliases a ON a.id = link.value
      LEFT JOIN contacts c ON c.id = COALESCE(a.canonical_id, link.value) AND c.deleted_at IS NULL
      ORDER BY link.key`, intent?.contact_ids ?? JSON.stringify(calendarContextIds(data.contact_ids))),
    db.getAllAsync<{ id: string; summary: string; contactId: string; contactName: string; completed_at: string | null }>(`SELECT p.id, COALESCE(NULLIF(p.summary, ''), 'Plan') summary, p.contact_id contactId, c.name contactName, p.completed_at
      FROM json_each(?) link JOIN plans p ON p.id = link.value AND p.deleted_at IS NULL
      JOIN contacts c ON c.id = p.contact_id AND c.deleted_at IS NULL ORDER BY link.key`, intent?.plan_ids ?? JSON.stringify(calendarContextIds(data.plan_ids))),
  ]);
  const people = linkedPeople.filter((person, i) => linkedPeople.findIndex((p) => p.id === person.id) === i);
  const plans = linkedPlans.map(({ completed_at, ...plan }) => ({ ...plan, completed: !!completed_at }));
  return { id: record.id, facts: readCalendarEventFacts(JSON.parse(String(data.facts))), accountEmail: String(data.account_email),
    calendarLabel: String(data.calendar_label), timeZone: String(data.calendar_time_zone), observedAt: String(data.observed_at),
    sourceStatus: data.source_status as NativeCalendarEvent['sourceStatus'], linksState: intent?.status ?? null, people, plans };
}
function offset(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Calendar page.'); return value; }
export async function listCalendarEvents(db: SQLiteDatabase, contactId?: string, after = 0, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid Calendar page size.');
  const person = contactId ? await canonicalContactId(db, contactId) : null;
  const rows = await db.getAllAsync<{ record_json: string }>(`SELECT e.record_json FROM calendar_events e LEFT JOIN calendar_event_link_queue q ON q.event_id = e.id WHERE ? IS NULL
    OR EXISTS (SELECT 1 FROM json_each(COALESCE(q.contact_ids, json_extract(e.record_json, '$.data.contact_ids'))) link
      LEFT JOIN contact_aliases a ON a.id = link.value WHERE COALESCE(a.canonical_id, link.value) = ?)
    OR EXISTS (SELECT 1 FROM json_each(COALESCE(q.plan_ids, json_extract(e.record_json, '$.data.plan_ids'))) link
      JOIN plans p ON p.id = link.value WHERE p.contact_id = ? AND p.deleted_at IS NULL)
    ORDER BY e.sort_at, e.id LIMIT ? OFFSET ?`, person, person, person, limit + 1, offset(after));
  return { events: await Promise.all(rows.slice(0, limit).map((row) => projectCalendarEvent(db, row.record_json))), more: rows.length > limit };
}
export async function getCalendarEvent(db: SQLiteDatabase, id: string) {
  const row = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM calendar_events WHERE id = ?', id);
  return row ? projectCalendarEvent(db, row.record_json) : null;
}
export async function listAgendaEntries(db: SQLiteDatabase, after = 0) {
  const rows = await db.getAllAsync<{ kind: 'plan' | 'source_event'; id: string; record_json: string | null }>(`SELECT 'plan' kind, p.id, p.planned_date || 'T00:00:00.000Z' sort_at, NULL record_json
    FROM plans p JOIN contacts c ON c.id = p.contact_id WHERE p.deleted_at IS NULL AND p.completed_at IS NULL AND c.deleted_at IS NULL
    UNION ALL SELECT 'source_event', id, sort_at, record_json FROM calendar_events ORDER BY sort_at, kind, id LIMIT 51 OFFSET ?`, offset(after));
  const entries: AgendaEntry[] = [];
  for (const row of rows.slice(0, 50)) {
    if (row.kind === 'source_event') entries.push({ kind: row.kind, event: await projectCalendarEvent(db, row.record_json!) });
    else {
      const plan = await db.getFirstAsync<ContextRecord>(`SELECT p.*, c.name contact_name FROM plans p JOIN contacts c ON c.id = p.contact_id WHERE p.id = ? AND p.deleted_at IS NULL AND p.completed_at IS NULL AND c.deleted_at IS NULL`, row.id);
      if (plan) entries.push({ kind: row.kind, record: plan });
    }
  }
  return { entries, more: rows.length > 50 };
}
