CREATE TABLE `provider_contact_index` (
	`connection_id` text NOT NULL,
	`generation` text NOT NULL,
	`source_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`facts` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_contact_index_identity_idx` ON `provider_contact_index` (`connection_id`,`generation`,`source_id`);--> statement-breakpoint
CREATE INDEX `provider_contact_index_resource_idx` ON `provider_contact_index` (`connection_id`,`generation`,`resource_name`);--> statement-breakpoint
CREATE TABLE `provider_contact_resources` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`active_generation` text,
	`sync_cursor` text,
	`cursor_issued_at` integer,
	`request_version` integer NOT NULL,
	`last_synced_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_contact_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`force_full` integer NOT NULL,
	`mode` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`generation` text NOT NULL,
	`base_generation` text,
	`input_cursor` text,
	`next_page` text,
	`copy_after` text,
	`pages` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`issue` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_contact_active_run_idx` ON `provider_contact_runs` (`connection_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `provider_contact_run_owner_idx` ON `provider_contact_runs` (`workspace_id`,`connection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_contact_run_retry_idx` ON `provider_contact_runs` (`status`,`next_attempt_at`,`updated_at`);--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `authorization_revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER provider_authorization_revision_guard BEFORE UPDATE ON provider_connections BEGIN
  SELECT CASE WHEN NEW.authorization_revision < OLD.authorization_revision
    OR (NEW.status IS NOT OLD.status AND OLD.status = 'connected' AND NEW.authorization_revision <= OLD.authorization_revision)
    THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_capacity_guard BEFORE INSERT ON cloud_maintenance_guards
WHEN NEW.allowed = -3 BEGIN SELECT RAISE(ABORT, 'PROVIDER_CONTACTS_LIMIT'); END;
--> statement-breakpoint
CREATE TRIGGER provider_contacts_authorization_fence AFTER UPDATE ON provider_connections
WHEN NEW.authorization_revision != OLD.authorization_revision OR NEW.dataset_epoch IS NOT OLD.dataset_epoch
  OR NEW.status IS NOT OLD.status BEGIN
  UPDATE provider_contact_runs SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
    issue = 'connection_changed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE connection_id = NEW.id AND status = 'active';
  DELETE FROM provider_contact_resources WHERE connection_id = NEW.id;
  DELETE FROM provider_contact_index WHERE connection_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contacts_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  UPDATE provider_contact_runs SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
    issue = 'dataset_changed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE workspace_id = NEW.workspace_id AND status = 'active';
  DELETE FROM provider_contact_index WHERE connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = NEW.workspace_id);
  DELETE FROM provider_contact_resources WHERE workspace_id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_resource_owner_guard BEFORE INSERT ON provider_contact_resources BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_members m
    ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.dataset_epoch = NEW.dataset_epoch
      AND c.authorization_revision = NEW.authorization_revision AND c.status = 'connected'
      AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active')
    THEN RAISE(ABORT, 'PROVIDER_CONTACTS_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_run_guard BEFORE INSERT ON provider_contact_runs BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NEW.mode NOT IN ('full', 'delta') OR NEW.phase NOT IN ('copy', 'fetch')
    OR NEW.force_full NOT IN (0, 1) OR NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_members m
      ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
      JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id
        AND c.dataset_epoch = NEW.dataset_epoch AND c.authorization_revision = NEW.authorization_revision
        AND c.status = 'connected' AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active')
    THEN RAISE(ABORT, 'PROVIDER_CONTACTS_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_index_guard BEFORE INSERT ON provider_contact_index BEGIN
  SELECT CASE WHEN length(NEW.source_id) < 1 OR length(NEW.source_id) > 255 OR length(NEW.resource_name) > 255
    OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object' OR length(CAST(NEW.facts AS BLOB)) > 24576
    OR json_extract(NEW.facts, '$.sourceId') IS NOT NEW.source_id OR json_extract(NEW.facts, '$.resourceName') IS NOT NEW.resource_name
    OR NOT EXISTS (SELECT 1 FROM provider_contact_runs r JOIN provider_connections c ON c.id = r.connection_id
      JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspace_members m
        ON m.workspace_id = c.workspace_id AND m.user_id = r.user_id AND m.role = 'owner'
      WHERE r.connection_id = NEW.connection_id AND r.generation = NEW.generation AND r.status = 'active'
        AND c.status = 'connected' AND c.authorization_revision = r.authorization_revision
        AND s.epoch = r.dataset_epoch AND c.dataset_epoch = r.dataset_epoch AND s.paused = 0)
    THEN RAISE(ABORT, 'PROVIDER_CONTACTS_INVALID') END;
END;
