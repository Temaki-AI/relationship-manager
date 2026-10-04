import { getCloudflareContext } from '@opennextjs/cloudflare';
import { MAX_CALENDAR_EVENTS, normalizeCalendarRange, type CalendarEvent, type CoreCalendarEvent, type SourceCalendarEvent } from '@/lib/calendar-directory';
import { birthdayMatchesDaySQL, createCivilDateFormatter, normalizeTimeZone, startOfCivilDayUTC } from '@/lib/civil-date';
import { readCalendarEventFacts } from '@/packages/domain/src/calendar-events';
import { calendarEventDayRange } from '@/packages/domain/src/calendar-event-display';
import { calendarSourceStatusSql } from '@/lib/cloud/calendar-event-projection';

export const MAX_CALENDAR_SOURCE_EVENTS = 100;
const MAX_SOURCE_CARD_BYTES = 512 * 1024;
const SOURCE_START = "COALESCE(json_extract(e.facts, '$.start'), json_extract(e.facts, '$.original_start'))";
const SOURCE_ACCESS = "EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = s.workspace_id WHERE s.workspace_id = e.workspace_id AND s.paused = 0 AND w.lifecycle = 'active' AND m.user_id = ? AND m.role = 'owner')";
type SourceRow = {
  public_id: string; facts: string; calendar_label: string; calendar_time_zone: string; account_email: string;
  observed_at: string; source_status: SourceCalendarEvent['source']['source_status']; people: string; plans: string;
};

function sourceCard(row: SourceRow, timeZone: string): SourceCalendarEvent | null {
  const facts = readCalendarEventFacts(JSON.parse(row.facts)), days = calendarEventDayRange(facts, timeZone);
  if (!days) return null;
  const { title, status, start, end, original_start, recurring_id, redacted, location, google_url, conference_url } = facts;
  return { id: 'source-event-' + row.public_id, kind: 'source_event', date: days.first, last_date: days.last,
    starts_at: (start ?? original_start)?.instant ?? null, title, detail: null, contact_id: null, contact_name: '', completed: false, source_id: null, subtype: 'google_calendar',
    source: { public_id: row.public_id, calendar_label: row.calendar_label, calendar_time_zone: row.calendar_time_zone, account_email: row.account_email,
      observed_at: row.observed_at, source_status: row.source_status, people: JSON.parse(row.people), plans: JSON.parse(row.plans),
      facts: { title, status, start, end, original_start, recurring_id, redacted, location, google_url, conference_url } } };
}

export async function cloudCalendarEvents(request: Request, workspaceId: string, userId?: string) {
  const db = getCloudflareContext().env.DB;
  const params = new URL(request.url).searchParams;
  const range = normalizeCalendarRange(params.get('start'), params.get('end'));
  const timeZone = normalizeTimeZone(params.get('timeZone'));
  const nextDay = new Date(Date.parse(`${range.end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const startInstant = startOfCivilDayUTC(range.start, timeZone);
  const endInstant = startOfCivilDayUTC(nextDay, timeZone);
  const limit = MAX_CALENDAR_EVENTS + 1;
  const result = await db.batch([
    db.prepare(`SELECT 'reminder-' || r.id AS id, 'reminder' AS kind, r.remind_at AS starts_at,
      r.title, r.notes AS detail, r.contact_id, c.name AS contact_name,
      r.completed_at IS NOT NULL AS completed, r.id AS source_id, 'reminder' AS subtype
      FROM reminders r JOIN contacts c ON c.id = r.contact_id AND c.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND julianday(r.remind_at) >= julianday(?) AND julianday(r.remind_at) < julianday(?)
      ORDER BY julianday(r.remind_at), r.id LIMIT ?`).bind(workspaceId, startInstant, endInstant, limit),
    db.prepare(`SELECT 'plan-' || p.id AS id, 'plan' AS kind, p.planned_date AS date, NULL AS starts_at,
      COALESCE(NULLIF(p.summary, ''), 'Plan') AS title, p.notes AS detail, p.contact_id, c.name AS contact_name,
      p.completed_at IS NOT NULL AS completed, p.id AS source_id, p.type AS subtype
      FROM plans p JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id
      WHERE p.workspace_id = ? AND p.planned_date BETWEEN ? AND ? ORDER BY p.planned_date, p.id LIMIT ?`)
      .bind(workspaceId, range.start, range.end, limit),
    db.prepare(`SELECT 'interaction-' || i.id AS id, 'interaction' AS kind, i.date, NULL AS starts_at,
      COALESCE(NULLIF(i.summary, ''), i.type) AS title, i.notes AS detail, i.contact_id, c.name AS contact_name,
      1 AS completed, i.id AS source_id, i.type AS subtype
      FROM interactions i JOIN contacts c ON c.id = i.contact_id AND c.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.date BETWEEN ? AND ? ORDER BY i.date, i.id LIMIT ?`)
      .bind(workspaceId, range.start, range.end, limit),
    db.prepare(`WITH RECURSIVE days(date) AS (VALUES (?) UNION ALL SELECT date(date, '+1 day') FROM days WHERE date < ?)
      SELECT 'birthday-contact-' || c.id || '-' || days.date AS id, 'birthday' AS kind, days.date, NULL AS starts_at,
      c.name || '''s birthday' AS title, NULL AS detail, c.id AS contact_id, c.name AS contact_name,
      0 AS completed, c.id AS source_id, 'contact' AS subtype
      FROM days JOIN contacts c ON c.workspace_id = ? AND ${birthdayMatchesDaySQL('c.birthday', 'days.date')}
      UNION ALL
      SELECT 'birthday-child-' || child.id || '-' || days.date, 'birthday', days.date, NULL,
      child.name || '''s birthday', 'Child of ' || c.name, c.id, c.name, 0, child.id, 'child'
      FROM days JOIN contact_children child ON child.workspace_id = ? AND child.linked_contact_id IS NULL
        AND ${birthdayMatchesDaySQL('child.birthday', 'days.date')}
      JOIN contacts c ON c.id = child.contact_id AND c.workspace_id = child.workspace_id
      ORDER BY date, id LIMIT ?`).bind(range.start, range.end, workspaceId, workspaceId, limit),
    // Facts, access status and current plan owners come from one database snapshot.
    db.prepare(`WITH moments AS (
      SELECT e.*, json_extract(${SOURCE_START}, '$.date') AS source_date,
        json_extract(${SOURCE_START}, '$.instant') AS source_instant,
        json_extract(e.facts, '$.end.date') AS end_date, json_extract(e.facts, '$.end.instant') AS end_instant
      FROM calendar_events e WHERE e.workspace_id = ?)
      SELECT e.public_id, e.facts, e.calendar_label, e.calendar_time_zone, e.account_email, e.observed_at,
        ${calendarSourceStatusSql()} AS source_status,
        COALESCE((SELECT json_group_array(json_object('id', id, 'name', name)) FROM (
          SELECT c.id, c.name FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id
          WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.name, c.id)), '[]') AS people,
        COALESCE((SELECT json_group_array(json_object('id', id, 'summary', summary, 'contact_id', contact_id, 'contact_name', contact_name, 'planned_date', planned_date)) FROM (
          SELECT p.id, COALESCE(NULLIF(p.summary, ''), 'Plan') AS summary, p.contact_id, c.name AS contact_name, p.planned_date
          FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id
          JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id
          WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.planned_date, p.id)), '[]') AS plans
      FROM moments e WHERE ${SOURCE_ACCESS}
        AND ((source_date <= ? AND CASE WHEN end_date > source_date THEN end_date ELSE date(source_date, '+1 day') END > ?)
          OR (julianday(source_instant) < julianday(?) AND (CASE WHEN julianday(end_instant) > julianday(source_instant)
            THEN julianday(end_instant) > julianday(?) ELSE julianday(source_instant) >= julianday(?) END)))
      ORDER BY COALESCE(source_date, source_instant), e.id LIMIT ?`)
      .bind(workspaceId, userId ?? '', range.end, range.start, endInstant, startInstant, startInstant, MAX_CALENDAR_SOURCE_EVENTS + 1),
    db.prepare(`SELECT EXISTS(SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.paused = 0 AND w.lifecycle = 'active' AND m.user_id = ? AND m.role = 'owner') AS available,
      EXISTS(SELECT 1 FROM calendar_events e WHERE e.workspace_id = ? AND ${SOURCE_ACCESS}
      AND json_extract(${SOURCE_START}, '$.date') IS NULL AND json_extract(${SOURCE_START}, '$.instant') IS NULL) AS uncertain`).bind(workspaceId, userId ?? '', workspaceId, userId ?? ''),
  ]);
  const pages = result.slice(0, 4) as Array<{ results: Array<Omit<CoreCalendarEvent, 'completed'> & { completed: number }> }>;
  const formatDate = createCivilDateFormatter(timeZone);
  const events: CalendarEvent[] = pages.flatMap((page) => page.results).map((row) => ({
    ...row, completed: Boolean(row.completed), date: row.starts_at ? formatDate(row.starts_at)! : row.date,
  }));
  const rows = result[4].results as SourceRow[];
  let sourceTruncated = rows.length > MAX_CALENDAR_SOURCE_EVENTS, sourceBytes = 0;
  for (const row of rows.slice(0, MAX_CALENDAR_SOURCE_EVENTS)) {
    const card = sourceCard(row, timeZone); if (!card) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(card)).byteLength;
    if (sourceBytes + bytes > MAX_SOURCE_CARD_BYTES) { sourceTruncated = true; break; }
    sourceBytes += bytes; events.push(card);
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.starts_at || '').localeCompare(b.starts_at || '') || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { events: events.slice(0, MAX_CALENDAR_EVENTS), range, truncated: events.length > MAX_CALENDAR_EVENTS,
    source_truncated: sourceTruncated, source_events_available: Boolean(result[5].results[0]?.available), source_date_uncertain: Boolean(result[5].results[0]?.uncertain) };
}
