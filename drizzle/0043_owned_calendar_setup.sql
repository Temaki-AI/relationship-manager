CREATE TABLE `provider_owned_calendars` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`request_json` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`attempted` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`calendar_id` text,
	`issue` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_owned_calendars_operation_idx` ON `provider_owned_calendars` (`operation_id`);
--> statement-breakpoint
DROP TRIGGER provider_connection_purpose_insert_guard;
--> statement-breakpoint
CREATE TRIGGER provider_connection_purpose_insert_guard BEFORE INSERT ON provider_connections BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar', 'calendar-publish') THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
DROP TRIGGER provider_authorization_purpose_guard;
--> statement-breakpoint
CREATE TRIGGER provider_authorization_purpose_guard BEFORE INSERT ON provider_authorization_attempts BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar', 'calendar-publish') OR (NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_connections WHERE id = NEW.connection_id AND purpose = NEW.purpose)) THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_owned_calendar_insert_guard BEFORE INSERT ON provider_owned_calendars BEGIN
  SELECT CASE WHEN NEW.attempted != 0 OR NEW.status != 'pending' OR NEW.calendar_id IS NOT NULL OR NEW.revision != 1
    OR length(NEW.operation_id) != 36 OR length(NEW.fingerprint) != 64 OR length(CAST(NEW.request_json AS BLOB)) > 4096
    OR NOT json_valid(NEW.request_json) OR json_type(NEW.request_json) != 'object' OR NOT EXISTS (
      SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
      JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
      WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id AND c.purpose = 'calendar-publish'
        AND c.status = 'connected' AND c.dataset_epoch = NEW.dataset_epoch AND s.epoch = NEW.dataset_epoch AND s.paused = 0
        AND c.authorization_revision = NEW.authorization_revision AND w.lifecycle = 'active' AND m.role = 'owner')
    THEN RAISE(ABORT, 'PROVIDER_OWNED_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_owned_calendar_update_guard BEFORE UPDATE ON provider_owned_calendars BEGIN
  SELECT CASE WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.request_json IS NOT OLD.request_json OR NEW.fingerprint IS NOT OLD.fingerprint
    OR NEW.attempted < OLD.attempted OR NEW.attempted NOT IN (0, 1) OR typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR NEW.revision < OLD.revision
    OR NEW.status NOT IN ('pending', 'unknown', 'ready', 'held') OR (NEW.status = 'ready' AND (NEW.attempted != 1 OR NEW.calendar_id IS NULL))
    OR (OLD.calendar_id IS NOT NULL AND NEW.calendar_id IS NOT OLD.calendar_id) OR length(NEW.calendar_id) > 1024 OR length(NEW.calendar_id) = 0
    THEN RAISE(ABORT, 'PROVIDER_OWNED_CALENDAR_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_owned_calendar_authorization_fence AFTER UPDATE OF status, authorization_revision, dataset_epoch ON provider_connections
WHEN NEW.purpose = 'calendar-publish' AND (NEW.status IS NOT OLD.status OR NEW.authorization_revision != OLD.authorization_revision OR NEW.dataset_epoch IS NOT OLD.dataset_epoch) BEGIN
  UPDATE provider_owned_calendars SET status = 'held', issue = 'authorization_changed', revision = revision + 1, lease_token = NULL, lease_until = NULL
    WHERE connection_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_owned_calendar_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  UPDATE provider_owned_calendars SET status = 'held', issue = 'dataset_changed', revision = revision + 1, lease_token = NULL, lease_until = NULL
    WHERE workspace_id = NEW.workspace_id;
END;
