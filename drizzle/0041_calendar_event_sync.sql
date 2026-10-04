-- Canonical Calendar context uses the shared journal; core protocol versions remain filtered.
CREATE TRIGGER sync_source_event_record_insert AFTER INSERT ON sync_entity_records
 WHEN NEW.entity_type = 'source_event' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
 SELECT NEW.workspace_id, epoch, NEW.entity_type, NEW.public_id, CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.revision, NEW.payload FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id;
 END;
--> statement-breakpoint
CREATE TRIGGER sync_source_event_record_update AFTER UPDATE ON sync_entity_records
 WHEN NEW.entity_type = 'source_event' AND (NEW.revision IS NOT OLD.revision OR NEW.payload IS NOT OLD.payload OR NEW.deleted_at IS NOT OLD.deleted_at) AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
 SELECT NEW.workspace_id, epoch, NEW.entity_type, NEW.public_id, CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.revision, NEW.payload FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id;
 END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_event_insert AFTER INSERT ON calendar_events BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id AND e.public_id = NEW.public_id AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_event_update AFTER UPDATE ON calendar_events BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id AND e.public_id = NEW.public_id AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_event_delete AFTER DELETE ON calendar_events WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0 BEGIN
 UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP WHERE workspace_id = OLD.workspace_id AND entity_type = 'source_event' AND public_id = OLD.public_id; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_connections_insert AFTER INSERT ON provider_connections BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_connections_update AFTER UPDATE ON provider_connections BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_connections_delete AFTER DELETE ON provider_connections BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = OLD.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_calendars_insert AFTER INSERT ON provider_calendars BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = NEW.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_calendars_update AFTER UPDATE ON provider_calendars BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = NEW.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_calendars_delete AFTER DELETE ON provider_calendars BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = OLD.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_event_resources_insert AFTER INSERT ON provider_event_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_event_resources_update AFTER UPDATE ON provider_event_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_provider_event_resources_delete AFTER DELETE ON provider_event_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = OLD.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_workspace_members_insert AFTER INSERT ON workspace_members BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_workspace_members_update AFTER UPDATE ON workspace_members BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = NEW.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_workspace_members_delete AFTER DELETE ON workspace_members BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = OLD.workspace_id  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_choices_insert AFTER INSERT ON provider_calendar_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = NEW.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_choices_update AFTER UPDATE ON provider_calendar_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = NEW.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER sync_calendar_access_choices_delete AFTER DELETE ON provider_calendar_resources BEGIN INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload)
 SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id
 WHERE e.workspace_id = (SELECT workspace_id FROM provider_connections WHERE id = OLD.connection_id)  AND s.paused = 0 AND w.lifecycle = 'active'
 ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL
 WHERE sync_entity_records.payload IS NOT excluded.payload OR sync_entity_records.deleted_at IS NOT NULL; END;
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, json_object('provider', e.provider, 'account_email', e.account_email, 'calendar_label', e.calendar_label,
    'calendar_time_zone', e.calendar_time_zone, 'observed_at', e.observed_at, 'source_status', COALESCE((SELECT CASE WHEN conn.status != 'connected' THEN 'review_required'
    WHEN calendar.availability IS NOT 'available' OR json_extract(calendar.facts, '$.access_role') = 'freeBusyReader' OR resource.availability = 'unavailable' OR e.availability != 'available' THEN 'unavailable'
    WHEN resource.active_generation IS NULL OR NOT EXISTS (SELECT 1 FROM provider_event_index observed WHERE observed.connection_id = conn.id AND observed.calendar_id = calendar.calendar_id AND observed.generation = resource.active_generation AND observed.event_id = e.external_id) THEN 'review_required'
    ELSE 'available' END
    FROM provider_connections conn JOIN workspace_sync_state state ON state.workspace_id = conn.workspace_id
    JOIN workspace_members member ON member.workspace_id = conn.workspace_id AND member.user_id = conn.user_id AND member.role = 'owner'
    JOIN provider_calendar_resources choices ON choices.connection_id = conn.id
    LEFT JOIN provider_calendars calendar ON calendar.connection_id = conn.id AND calendar.calendar_id = e.calendar_key
    LEFT JOIN provider_event_resources resource ON resource.connection_id = conn.id AND resource.calendar_id = e.calendar_key
    WHERE conn.workspace_id = e.workspace_id AND conn.provider = 'google' AND conn.purpose = 'calendar' AND conn.account_id = e.account_key
      AND conn.dataset_epoch = state.epoch AND state.paused = 0 AND (conn.refresh_expires_at IS NULL OR conn.refresh_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      AND EXISTS (SELECT 1 FROM json_each(choices.selected_ids) WHERE value = e.calendar_key) LIMIT 1), 'review_required'), 'facts', e.facts,
    'contact_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT c.public_id FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY c.public_id)), '[]') || '',
    'plan_ids', COALESCE((SELECT json_group_array(public_id) FROM (SELECT p.public_id FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id ORDER BY p.public_id)), '[]') || '') FROM calendar_events e JOIN workspace_sync_state s ON s.workspace_id = e.workspace_id JOIN workspaces w ON w.id = e.workspace_id WHERE s.paused = 0 AND w.lifecycle = 'active';
