import { dateInTimeZone } from '@/lib/civil-date';
export function calendarEventObservationStatements(db: CloudflareEnv['DB'], workspaceId: string, accountKey: string, calendarId: string, generation: string, windowStart: string, windowEnd: string, now: string, label: string, timeZone: string) {
  const source = `SELECT facts FROM provider_event_index WHERE connection_id = ? AND calendar_id = ? AND generation = ? AND event_id = calendar_events.external_id`;
  // Caller supplies the connection ID separately, while matching uses verified account identity.
  return (connectionId: string) => [
    db.prepare(`UPDATE calendar_events SET revision = revision + CASE WHEN facts IS NOT (${source}) OR availability != 'available' OR calendar_label != ? OR calendar_time_zone != ? THEN 1 ELSE 0 END,
      facts = (${source}), availability = 'available', observed_at = ?, updated_at = ?, calendar_label = ?, calendar_time_zone = ?
      WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND EXISTS (${source})`)
      .bind(connectionId, calendarId, generation, label, timeZone, connectionId, calendarId, generation, now, now, label, timeZone, workspaceId, accountKey, calendarId, connectionId, calendarId, generation),
    db.prepare(`UPDATE calendar_events SET availability = 'unavailable', revision = revision + 1, observed_at = ?, updated_at = ?
      WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND availability != 'unavailable'
      AND ((json_extract(facts, '$.start.instant') IS NOT NULL AND julianday(json_extract(facts, '$.start.instant')) < julianday(?) AND julianday(json_extract(facts, '$.end.instant')) > julianday(?))
        OR (json_extract(facts, '$.start.date') IS NOT NULL AND json_extract(facts, '$.start.date') < ? AND json_extract(facts, '$.end.date') > ?))
      AND NOT EXISTS (${source})`)
      .bind(now, now, workspaceId, accountKey, calendarId, windowEnd, windowStart, dateInTimeZone(windowEnd, timeZone), dateInTimeZone(windowStart, timeZone), connectionId, calendarId, generation),
  ];
}
