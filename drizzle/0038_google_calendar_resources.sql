CREATE TABLE `provider_calendar_catalog` (
	`connection_id` text NOT NULL,
	`generation` text NOT NULL,
	`calendar_id` text NOT NULL,
	`facts` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_calendar_catalog_identity_idx` ON `provider_calendar_catalog` (`connection_id`,`generation`,`calendar_id`);--> statement-breakpoint
CREATE TABLE `provider_calendar_resources` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`active_generation` text,
	`selection_revision` integer DEFAULT 1 NOT NULL,
	`selected_ids` text DEFAULT '[]' NOT NULL,
	`last_discovered_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_calendar_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`generation` text NOT NULL,
	`base_generation` text,
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
CREATE INDEX `provider_calendar_runs_connection_idx` ON `provider_calendar_runs` (`connection_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_calendar_selection_receipts` (
	`connection_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result_revision` integer NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_calendar_selection_identity_idx` ON `provider_calendar_selection_receipts` (`connection_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `provider_calendars` (
	`connection_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`facts` text NOT NULL,
	`availability` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_calendars_identity_idx` ON `provider_calendars` (`connection_id`,`calendar_id`);--> statement-breakpoint
DROP INDEX `provider_connections_identity_idx`;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `purpose` text DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_identity_idx` ON `provider_connections` (`workspace_id`,`provider`,`account_id`,`purpose`);--> statement-breakpoint
ALTER TABLE `provider_authorization_attempts` ADD `purpose` text DEFAULT 'contacts' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER provider_connection_purpose_insert_guard BEFORE INSERT ON provider_connections BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar') THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_connection_purpose_update_guard BEFORE UPDATE ON provider_connections BEGIN
  SELECT CASE WHEN NEW.purpose IS NOT OLD.purpose THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_authorization_purpose_guard BEFORE INSERT ON provider_authorization_attempts BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar') OR (NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_connections WHERE id = NEW.connection_id AND purpose = NEW.purpose)) THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE UNIQUE INDEX provider_calendar_active_run_idx ON provider_calendar_runs (connection_id) WHERE status = 'active';
--> statement-breakpoint
CREATE TRIGGER provider_calendar_resource_insert_guard BEFORE INSERT ON provider_calendar_resources BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
    WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.purpose = 'calendar' AND c.status = 'connected'
      AND c.authorization_revision = NEW.authorization_revision AND c.dataset_epoch = NEW.dataset_epoch AND s.epoch = NEW.dataset_epoch
      AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner') OR NEW.selection_revision < 1
    OR NOT json_valid(NEW.selected_ids) OR json_type(NEW.selected_ids) != 'array' OR json_array_length(NEW.selected_ids) > 20
    THEN RAISE(ABORT, 'PROVIDER_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendar_resource_update_guard BEFORE UPDATE ON provider_calendar_resources BEGIN
  SELECT CASE WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.dataset_epoch IS NOT OLD.dataset_epoch OR NEW.authorization_revision IS NOT OLD.authorization_revision
    OR NEW.selection_revision < OLD.selection_revision OR NOT json_valid(NEW.selected_ids) OR json_type(NEW.selected_ids) != 'array'
    OR json_array_length(NEW.selected_ids) > 20 THEN RAISE(ABORT, 'PROVIDER_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendar_catalog_guard BEFORE INSERT ON provider_calendar_catalog BEGIN
  SELECT CASE WHEN length(CAST(NEW.facts AS BLOB)) > 8192 OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object'
    OR NOT EXISTS (SELECT 1 FROM provider_calendar_runs r JOIN provider_connections c ON c.id = r.connection_id
      WHERE r.connection_id = NEW.connection_id AND r.generation = NEW.generation AND r.status = 'active' AND c.purpose = 'calendar')
    OR (SELECT COUNT(*) FROM provider_calendar_catalog WHERE connection_id = NEW.connection_id AND generation = NEW.generation) >= 500
    THEN RAISE(ABORT, 'PROVIDER_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendars_insert_guard BEFORE INSERT ON provider_calendars BEGIN
  SELECT CASE WHEN NEW.availability NOT IN ('available', 'unavailable') OR length(CAST(NEW.facts AS BLOB)) > 8192
    OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object'
    OR NOT EXISTS (SELECT 1 FROM provider_connections WHERE id = NEW.connection_id AND purpose = 'calendar')
    THEN RAISE(ABORT, 'PROVIDER_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendars_update_guard BEFORE UPDATE ON provider_calendars BEGIN
  SELECT CASE WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.calendar_id IS NOT OLD.calendar_id
    OR NEW.availability NOT IN ('available', 'unavailable') OR length(CAST(NEW.facts AS BLOB)) > 8192
    OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object' THEN RAISE(ABORT, 'PROVIDER_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendar_authorization_fence AFTER UPDATE OF status, authorization_revision, dataset_epoch ON provider_connections
WHEN NEW.purpose = 'calendar' AND (NEW.status IS NOT OLD.status OR NEW.authorization_revision != OLD.authorization_revision OR NEW.dataset_epoch IS NOT OLD.dataset_epoch) BEGIN
  UPDATE provider_calendar_runs SET status = 'cancelled', issue = 'authorization_changed', lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.id AND status = 'active';
  DELETE FROM provider_calendar_catalog WHERE connection_id = NEW.id;
  DELETE FROM provider_calendars WHERE connection_id = NEW.id;
  DELETE FROM provider_calendar_resources WHERE connection_id = NEW.id;
  DELETE FROM provider_calendar_selection_receipts WHERE connection_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_calendar_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  UPDATE provider_calendar_runs SET status = 'cancelled', issue = 'dataset_changed', lease_token = NULL, lease_until = NULL WHERE workspace_id = NEW.workspace_id AND status = 'active';
  DELETE FROM provider_calendar_catalog WHERE connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = NEW.workspace_id);
  DELETE FROM provider_calendars WHERE connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = NEW.workspace_id);
  DELETE FROM provider_calendar_resources WHERE workspace_id = NEW.workspace_id;
  DELETE FROM provider_calendar_selection_receipts WHERE connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = NEW.workspace_id);
END;
