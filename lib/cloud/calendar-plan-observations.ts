import { dateInTimeZone } from '@/lib/civil-date';
import type { CalendarEventFacts } from '@/packages/domain/src/calendar-events';

/** Build date-only changes from a complete staged generation; the caller commits these with its source observations. */
export async function calendarPlanObservationStatements(db: CloudflareEnv['DB'], workspaceId: string, accountId: string, readerId: string, calendarId: string, generation: string, finalPage: CalendarEventFacts[], timeZone: string) {
  const rows = await db.prepare(`SELECT publication.event_id, staged.facts FROM calendar_plan_publications publication
    JOIN provider_connections writer ON writer.id = publication.connection_id
    LEFT JOIN provider_event_index staged ON staged.connection_id = ? AND staged.calendar_id = ? AND staged.generation = ? AND staged.event_id = publication.event_id
    WHERE publication.workspace_id = ? AND writer.account_id = ? AND publication.calendar_id = ? AND publication.follow_date = 1 LIMIT 5001`)
    .bind(readerId, calendarId, generation, workspaceId, accountId, calendarId).all<{ event_id: string; facts: string | null }>() as { results: Array<{ event_id: string; facts: string | null }> };
  if (rows.results.length > 5000) throw new Error('CALENDAR_PUBLICATION_OBSERVATION_LIMIT');
  const page = new Map(finalPage.map((event) => [event.id, event])), dates = rows.results.flatMap((row) => {
    const event = page.get(row.event_id) ?? (row.facts ? JSON.parse(row.facts) as CalendarEventFacts : null);
    if (!event) return [];
    const day = event.start?.date ?? (event.start?.instant ? dateInTimeZone(event.start.instant, event.start.time_zone ?? timeZone) : null);
    return [{ id: row.event_id, day, cancelled: event.status === 'cancelled' }];
  });
  const now = Date.now(), statements: Array<ReturnType<CloudflareEnv['DB']['prepare']>> = [];
  // Chunk the mapping rather than interpolating IDs or exceeding SQLite parameter/string limits.
  for (let offset = 0; offset < dates.length; offset += 40) {
    const mapping = JSON.stringify(dates.slice(offset, offset + 40));
    const eligible = `publication.workspace_id = ? AND publication.calendar_id = ? AND publication.follow_date = 1 AND publication.status = 'published'
      AND publication.confirmed_at IS NOT NULL AND (publication.lease_token IS NULL OR publication.lease_until < ?)
      AND EXISTS (SELECT 1 FROM provider_connections writer JOIN workspace_sync_state state ON state.workspace_id = writer.workspace_id
        JOIN workspaces workspace ON workspace.id = writer.workspace_id
        JOIN workspace_members member ON member.workspace_id = writer.workspace_id AND member.user_id = writer.user_id AND member.role = 'owner'
        JOIN provider_owned_calendars setup ON setup.connection_id = writer.id
        WHERE writer.id = publication.connection_id AND writer.workspace_id = publication.workspace_id AND writer.account_id = ? AND writer.purpose = 'calendar-publish'
          AND writer.status = 'connected' AND writer.dataset_epoch = state.epoch AND state.paused = 0 AND workspace.lifecycle = 'active'
          AND (writer.refresh_expires_at IS NULL OR writer.refresh_expires_at > ?) AND setup.status = 'ready' AND setup.dataset_epoch = state.epoch
          AND setup.authorization_revision = writer.authorization_revision AND setup.calendar_id = publication.calendar_id)
      AND EXISTS (SELECT 1 FROM provider_event_index staged WHERE staged.connection_id = ? AND staged.calendar_id = publication.calendar_id AND staged.generation = ? AND staged.event_id = publication.event_id)`;
    const values = [workspaceId, calendarId, now, accountId, now, readerId, generation];
    const matched = `EXISTS (SELECT 1 FROM json_each(?) mapped WHERE json_extract(mapped.value, '$.id') = publication.event_id)`;
    const day = `(SELECT json_extract(mapped.value, '$.day') FROM json_each(?) mapped WHERE json_extract(mapped.value, '$.id') = publication.event_id)`;
    statements.push(db.prepare(`UPDATE calendar_plan_publications AS publication SET follow_date = 0, issue = 'plan_date_following_suspended', revision = revision + 1
      WHERE ${eligible} AND ${matched} AND (EXISTS (SELECT 1 FROM plans plan WHERE plan.workspace_id = publication.workspace_id AND plan.public_id = publication.plan_public_id
        AND (plan.completed_at IS NOT NULL OR plan.planned_date IS NOT publication.last_plan_date))
      OR EXISTS (SELECT 1 FROM json_each(?) mapped WHERE json_extract(mapped.value, '$.id') = publication.event_id AND (json_extract(mapped.value, '$.cancelled') = 1 OR json_extract(mapped.value, '$.day') IS NULL)))`)
      .bind(...values, mapping, mapping));
    statements.push(db.prepare(`UPDATE plans AS plan SET planned_date = (SELECT ${day} FROM calendar_plan_publications publication
        WHERE publication.workspace_id = plan.workspace_id AND publication.plan_public_id = plan.public_id)
      WHERE plan.completed_at IS NULL AND EXISTS (SELECT 1 FROM calendar_plan_publications publication
        WHERE publication.workspace_id = plan.workspace_id AND publication.plan_public_id = plan.public_id AND ${eligible} AND ${matched}
          AND publication.last_plan_date = plan.planned_date AND ${day} IS NOT NULL AND ${day} != plan.planned_date)`)
      .bind(mapping, ...values, mapping, mapping, mapping));
    statements.push(db.prepare(`UPDATE calendar_plan_publications AS publication SET last_plan_date = ${day}, revision = revision + 1
      WHERE ${eligible} AND ${matched} AND ${day} IS NOT NULL AND publication.last_plan_date IS NOT ${day}
        AND EXISTS (SELECT 1 FROM plans plan WHERE plan.workspace_id = publication.workspace_id AND plan.public_id = publication.plan_public_id AND plan.completed_at IS NULL AND plan.planned_date = ${day})`)
      .bind(mapping, ...values, mapping, mapping, mapping, mapping));
  }
  return statements;
}
