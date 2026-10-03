import { getCloudflareContext } from '@opennextjs/cloudflare';
import { MAX_CALENDAR_EVENTS, normalizeCalendarRange, type CalendarEvent } from '@/lib/calendar-directory';
import { birthdayMatchesDaySQL, createCivilDateFormatter, normalizeTimeZone, startOfCivilDayUTC } from '@/lib/civil-date';

export async function cloudCalendarEvents(request: Request, workspaceId: string) {
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
  ]);
  const pages = result as Array<{ results: Array<Omit<CalendarEvent, 'completed'> & { completed: number }> }>;
  const formatDate = createCivilDateFormatter(timeZone);
  const events: CalendarEvent[] = pages.flatMap((page) => page.results).map((row) => ({
    ...row, completed: Boolean(row.completed), date: row.starts_at ? formatDate(row.starts_at)! : row.date,
  }));
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.starts_at || '').localeCompare(b.starts_at || '') || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { events: events.slice(0, MAX_CALENDAR_EVENTS), range, truncated: events.length > MAX_CALENDAR_EVENTS };
}
