CREATE TABLE `provider_event_index` (
	`connection_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`generation` text NOT NULL,
	`event_id` text NOT NULL,
	`sort_key` text NOT NULL,
	`facts` text NOT NULL,
	PRIMARY KEY(`connection_id`, `calendar_id`, `generation`, `event_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_event_index_order_idx` ON `provider_event_index` (`connection_id`,`calendar_id`,`generation`,`sort_key`,`event_id`);--> statement-breakpoint
CREATE TABLE `provider_event_pages` (
	`run_id` text NOT NULL,
	`token_hash` text NOT NULL,
	PRIMARY KEY(`run_id`, `token_hash`),
	FOREIGN KEY (`run_id`) REFERENCES `provider_event_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_event_resources` (
	`connection_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`active_generation` text,
	`window_start` text,
	`window_end` text,
	`last_downloaded_at` text,
	`availability` text DEFAULT 'available' NOT NULL,
	PRIMARY KEY(`connection_id`, `calendar_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_event_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`selection_revision` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`generation` text NOT NULL,
	`base_generation` text,
	`calendar_time_zone` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`next_page` text,
	`pages` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`issue` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_event_runs_resource_idx` ON `provider_event_runs` (`connection_id`,`calendar_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX provider_event_runs_one_active ON provider_event_runs(connection_id, calendar_id) WHERE status = 'active';
--> statement-breakpoint
CREATE TRIGGER provider_event_resource_insert_guard BEFORE INSERT ON provider_event_resources BEGIN
  SELECT CASE WHEN NEW.availability NOT IN ('available', 'unavailable') OR NOT EXISTS (
    SELECT 1 FROM provider_connections c JOIN provider_calendar_resources r ON r.connection_id = c.id
    JOIN provider_calendars k ON k.connection_id = c.id AND k.calendar_id = NEW.calendar_id
    WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.purpose = 'calendar' AND c.status = 'connected'
      AND EXISTS (SELECT 1 FROM json_each(r.selected_ids) WHERE value = NEW.calendar_id))
    THEN RAISE(ABORT, 'PROVIDER_EVENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_resource_update_guard BEFORE UPDATE ON provider_event_resources BEGIN
  SELECT CASE WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.calendar_id IS NOT OLD.calendar_id OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.availability NOT IN ('available', 'unavailable') THEN RAISE(ABORT, 'PROVIDER_EVENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_run_insert_guard BEFORE INSERT ON provider_event_runs BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NEW.pages != 0 OR NEW.processed != 0 OR NEW.revision != 1 OR NEW.window_start >= NEW.window_end
    OR NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
      JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
      JOIN provider_calendar_resources r ON r.connection_id = c.id JOIN provider_calendars k ON k.connection_id = c.id AND k.calendar_id = NEW.calendar_id
      WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id AND c.purpose = 'calendar' AND c.status = 'connected'
        AND c.dataset_epoch = NEW.dataset_epoch AND s.epoch = NEW.dataset_epoch AND c.authorization_revision = NEW.authorization_revision
        AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner' AND r.selection_revision = NEW.selection_revision
        AND k.availability = 'available' AND json_extract(k.facts, '$.access_role') != 'freeBusyReader'
        AND EXISTS (SELECT 1 FROM json_each(r.selected_ids) WHERE value = NEW.calendar_id))
    THEN RAISE(ABORT, 'PROVIDER_EVENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_run_update_guard BEFORE UPDATE ON provider_event_runs BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.calendar_id IS NOT OLD.calendar_id
    OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.dataset_epoch IS NOT OLD.dataset_epoch
    OR NEW.authorization_revision != OLD.authorization_revision OR NEW.selection_revision != OLD.selection_revision OR NEW.fingerprint IS NOT OLD.fingerprint
    OR NEW.generation IS NOT OLD.generation OR NEW.base_generation IS NOT OLD.base_generation OR NEW.window_start IS NOT OLD.window_start
    OR NEW.window_end IS NOT OLD.window_end OR NEW.calendar_time_zone IS NOT OLD.calendar_time_zone
    OR NEW.status NOT IN ('active', 'complete', 'failed', 'cancelled') OR NEW.pages < 0 OR NEW.pages > 200 OR NEW.processed < 0 OR NEW.processed > 5000
    OR NEW.revision < OLD.revision OR length(NEW.next_page) > 8192 THEN RAISE(ABORT, 'PROVIDER_EVENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_index_insert_guard BEFORE INSERT ON provider_event_index BEGIN
  SELECT CASE WHEN length(CAST(NEW.facts AS BLOB)) > 65536 OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object'
    OR json_extract(NEW.facts, '$.id') IS NOT NEW.event_id OR length(NEW.event_id) > 1024 OR length(NEW.sort_key) != 19
    OR NOT EXISTS (SELECT 1 FROM provider_event_runs r JOIN provider_connections c ON c.id = r.connection_id
      JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN provider_calendar_resources k ON k.connection_id = c.id
      WHERE r.connection_id = NEW.connection_id AND r.calendar_id = NEW.calendar_id AND r.generation = NEW.generation AND r.status = 'active'
        AND c.purpose = 'calendar' AND c.status = 'connected' AND c.authorization_revision = r.authorization_revision
        AND c.dataset_epoch = r.dataset_epoch AND s.epoch = r.dataset_epoch AND s.paused = 0 AND k.selection_revision = r.selection_revision
        AND EXISTS (SELECT 1 FROM json_each(k.selected_ids) WHERE value = NEW.calendar_id))
    OR (SELECT COUNT(*) FROM provider_event_index WHERE connection_id = NEW.connection_id AND calendar_id = NEW.calendar_id AND generation = NEW.generation) >= 5000
    THEN RAISE(ABORT, 'PROVIDER_EVENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_index_update_guard BEFORE UPDATE ON provider_event_index BEGIN
  SELECT RAISE(ABORT, 'PROVIDER_EVENT_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_selection_fence AFTER UPDATE OF selection_revision ON provider_calendar_resources
WHEN NEW.selection_revision != OLD.selection_revision BEGIN
  UPDATE provider_event_runs SET status = 'cancelled', issue = 'calendar_choices_changed', lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.connection_id AND status = 'active';
  DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE connection_id = NEW.connection_id);
  DELETE FROM provider_event_index WHERE connection_id = NEW.connection_id AND (calendar_id NOT IN (SELECT value FROM json_each(NEW.selected_ids))
    OR generation IS NOT (SELECT active_generation FROM provider_event_resources WHERE connection_id = NEW.connection_id AND calendar_id = provider_event_index.calendar_id));
  DELETE FROM provider_event_resources WHERE connection_id = NEW.connection_id AND calendar_id NOT IN (SELECT value FROM json_each(NEW.selected_ids));
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_calendar_resource_delete_fence AFTER DELETE ON provider_calendar_resources BEGIN
  UPDATE provider_event_runs SET status = 'cancelled', issue = 'calendar_access_changed', lease_token = NULL, lease_until = NULL WHERE connection_id = OLD.connection_id AND status = 'active';
  DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE connection_id = OLD.connection_id);
  DELETE FROM provider_event_index WHERE connection_id = OLD.connection_id;
  DELETE FROM provider_event_resources WHERE connection_id = OLD.connection_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_authorization_fence AFTER UPDATE OF status, authorization_revision, dataset_epoch ON provider_connections
WHEN NEW.purpose = 'calendar' AND (NEW.status IS NOT OLD.status OR NEW.authorization_revision != OLD.authorization_revision OR NEW.dataset_epoch IS NOT OLD.dataset_epoch) BEGIN
  UPDATE provider_event_runs SET status = 'cancelled', issue = 'authorization_changed', lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.id AND status = 'active';
  DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE connection_id = NEW.id);
  DELETE FROM provider_event_index WHERE connection_id = NEW.id;
  DELETE FROM provider_event_resources WHERE connection_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_event_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  UPDATE provider_event_runs SET status = 'cancelled', issue = 'dataset_changed', lease_token = NULL, lease_until = NULL WHERE workspace_id = NEW.workspace_id AND status = 'active';
  DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE workspace_id = NEW.workspace_id);
  DELETE FROM provider_event_index WHERE connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = NEW.workspace_id);
  DELETE FROM provider_event_resources WHERE workspace_id = NEW.workspace_id;
END;
