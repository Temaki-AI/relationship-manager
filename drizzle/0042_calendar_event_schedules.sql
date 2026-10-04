ALTER TABLE `provider_event_resources` ADD `sync_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_event_resources` ADD `sync_interval` integer DEFAULT 86400 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_event_resources` ADD `settings_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_event_resources` ADD `past_days` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_event_resources` ADD `future_days` integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_event_resources` ADD `next_sync_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `provider_event_resources_due_idx` ON `provider_event_resources` (`sync_enabled`,`next_sync_at`);--> statement-breakpoint
ALTER TABLE `provider_event_runs` ADD `schedule_revision` integer;
--> statement-breakpoint
CREATE TRIGGER provider_event_schedule_insert_guard BEFORE INSERT ON provider_event_resources BEGIN
  SELECT CASE WHEN NEW.sync_enabled NOT IN (0, 1) OR NEW.sync_interval NOT IN (3600, 86400)
    OR NEW.settings_revision < 0 OR NEW.past_days < 0 OR NEW.future_days < 0 OR NEW.past_days + NEW.future_days > 365
    OR NEW.next_sync_at < 0 OR typeof(NEW.sync_enabled) != 'integer' OR typeof(NEW.sync_interval) != 'integer'
    OR typeof(NEW.settings_revision) != 'integer' OR typeof(NEW.past_days) != 'integer' OR typeof(NEW.future_days) != 'integer'
    OR typeof(NEW.next_sync_at) != 'integer' THEN RAISE(ABORT, 'PROVIDER_EVENT_SCHEDULE_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_schedule_update_guard BEFORE UPDATE ON provider_event_resources BEGIN
  SELECT CASE WHEN NEW.sync_enabled NOT IN (0, 1) OR NEW.sync_interval NOT IN (3600, 86400)
    OR NEW.settings_revision < OLD.settings_revision OR NEW.past_days < 0 OR NEW.future_days < 0 OR NEW.past_days + NEW.future_days > 365
    OR NEW.next_sync_at < 0 OR typeof(NEW.sync_enabled) != 'integer' OR typeof(NEW.sync_interval) != 'integer'
    OR typeof(NEW.settings_revision) != 'integer' OR typeof(NEW.past_days) != 'integer' OR typeof(NEW.future_days) != 'integer'
    OR typeof(NEW.next_sync_at) != 'integer' OR ((NEW.sync_enabled != OLD.sync_enabled OR NEW.sync_interval != OLD.sync_interval
      OR NEW.past_days != OLD.past_days OR NEW.future_days != OLD.future_days) AND NEW.settings_revision != OLD.settings_revision + 1)
    THEN RAISE(ABORT, 'PROVIDER_EVENT_SCHEDULE_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_schedule_fence AFTER UPDATE OF sync_enabled, sync_interval, settings_revision, past_days, future_days ON provider_event_resources
WHEN NEW.sync_enabled != OLD.sync_enabled OR NEW.sync_interval != OLD.sync_interval OR NEW.settings_revision != OLD.settings_revision
  OR NEW.past_days != OLD.past_days OR NEW.future_days != OLD.future_days BEGIN
  UPDATE provider_event_runs SET status = 'cancelled', issue = 'schedule_changed', revision = revision + 1,
    lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.connection_id AND calendar_id = NEW.calendar_id
      AND status = 'active' AND schedule_revision IS NOT NULL;
  DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE connection_id = NEW.connection_id
    AND calendar_id = NEW.calendar_id AND status = 'cancelled' AND issue = 'schedule_changed');
  DELETE FROM provider_event_index WHERE connection_id = NEW.connection_id AND calendar_id = NEW.calendar_id
    AND generation IS NOT NEW.active_generation AND generation IN (SELECT generation FROM provider_event_runs
      WHERE connection_id = NEW.connection_id AND calendar_id = NEW.calendar_id AND status = 'cancelled' AND issue = 'schedule_changed');
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_scheduled_run_insert_guard BEFORE INSERT ON provider_event_runs
WHEN NEW.schedule_revision IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.schedule_revision < 1 OR typeof(NEW.schedule_revision) != 'integer' OR NOT EXISTS (SELECT 1 FROM provider_event_resources p
    WHERE p.connection_id = NEW.connection_id AND p.calendar_id = NEW.calendar_id AND p.sync_enabled = 1
      AND p.settings_revision = NEW.schedule_revision) THEN RAISE(ABORT, 'PROVIDER_EVENT_SCHEDULE_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_scheduled_run_update_guard BEFORE UPDATE OF schedule_revision ON provider_event_runs BEGIN
  SELECT CASE WHEN NEW.schedule_revision IS NOT OLD.schedule_revision THEN RAISE(ABORT, 'PROVIDER_EVENT_SCHEDULE_INVALID') END;
END;
