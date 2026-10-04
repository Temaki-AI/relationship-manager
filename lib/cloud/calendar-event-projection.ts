/** Access is a workspace source observation, not permission for a phone to manage a Google grant. */
export function calendarSourceStatusSql(event = 'e') {
  return `COALESCE((SELECT CASE WHEN conn.status != 'connected' OR setup.status != 'ready' OR publication.status != 'published' THEN 'review_required'
    WHEN ${event}.availability != 'available' THEN 'unavailable' ELSE 'available' END
    FROM calendar_plan_publications publication JOIN provider_connections conn ON conn.id = publication.connection_id
    JOIN provider_owned_calendars setup ON setup.connection_id = conn.id
    JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    WHERE publication.workspace_id = ${event}.workspace_id AND conn.purpose = 'calendar-publish' AND conn.account_id = ${event}.account_key
      AND publication.calendar_id = ${event}.calendar_key AND publication.event_id = ${event}.external_id AND publication.confirmed_at IS NOT NULL
      AND setup.calendar_id = publication.calendar_id AND setup.dataset_epoch = state.epoch AND setup.authorization_revision = conn.authorization_revision
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) LIMIT 1), (SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR ${event}.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = ${event}.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = ${event}.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = ${event}.calendar_key
    WHERE conn.workspace_id = ${event}.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = ${event}.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = ${event}.calendar_key) LIMIT 1), 'review_required')`;
}
export function calendarEventProjectionSql(event = 'e') {
  return `json_object('provider', ${event}.provider, 'account_email', ${event}.account_email, 'calendar_label', ${event}.calendar_label,
    'calendar_time_zone', ${event}.calendar_time_zone, 'observed_at', ${event}.observed_at, 'source_status', ${calendarSourceStatusSql(event)}, 'facts', ${event}.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = ${event}.workspace_id AND link.event_id = ${event}.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = ${event}.workspace_id AND link.event_id = ${event}.id ORDER BY p.public_id)), '[]') || '')`;
}
/** Lazy expiry checks also advance the shared journal, so a continuation cannot mix access states. */
export async function refreshCalendarEventProjections(db: CloudflareEnv['DB'], workspaceId: string) {
  await db.prepare(`INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
    SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, ${calendarEventProjectionSql()} FROM calendar_events e
    JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
    WHERE e.workspace_id = ? AND s.paused = 0 AND w.lifecycle = 'active'
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
      WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL`).bind(workspaceId).run();
}
