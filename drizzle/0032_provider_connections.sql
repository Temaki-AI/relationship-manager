CREATE TABLE `provider_authorization_attempts` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`connection_id` text,
	`connection_revision` integer,
	`verifier` text NOT NULL,
	`claim_token` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_authorization_owner_idx` ON `provider_authorization_attempts` (`workspace_id`,`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`granted_scopes` text NOT NULL,
	`status` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`credentials` text,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`lease_token` text,
	`lease_until` integer,
	`issue` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_identity_idx` ON `provider_connections` (`workspace_id`,`provider`,`account_id`);--> statement-breakpoint
CREATE INDEX `provider_connections_owner_idx` ON `provider_connections` (`workspace_id`,`user_id`);
--> statement-breakpoint
CREATE TRIGGER provider_connection_insert_guard BEFORE INSERT ON provider_connections BEGIN
  SELECT CASE WHEN NEW.provider != 'google' OR NEW.status != 'connected' OR NEW.revision < 1
    OR NEW.credentials IS NULL OR length(CAST(NEW.credentials AS BLOB)) > 36864
    OR NOT json_valid(NEW.granted_scopes) OR json_type(NEW.granted_scopes) != 'array'
    OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND role = 'owner')
    OR NOT EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.workspace_id = NEW.workspace_id AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active')
    THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_connection_update_guard BEFORE UPDATE ON provider_connections BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.provider IS NOT OLD.provider OR NEW.account_id IS NOT OLD.account_id OR NEW.revision < OLD.revision
    OR NEW.status NOT IN ('connected', 'reconnect_required', 'disconnected', 'revocation_pending')
    OR length(CAST(NEW.credentials AS BLOB)) > 36864
    OR (NEW.status IN ('disconnected', 'reconnect_required') AND NEW.credentials IS NOT NULL)
    OR (NEW.credentials IS NOT OLD.credentials AND NEW.status = 'connected' AND NOT EXISTS (
      SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = NEW.user_id AND m.role = 'owner'
      WHERE s.workspace_id = NEW.workspace_id AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active'))
    THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_authorization_owner_guard BEFORE INSERT ON provider_authorization_attempts BEGIN
  SELECT CASE WHEN length(CAST(NEW.verifier AS BLOB)) > 36864
    OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND role = 'owner')
    OR (NEW.connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_connections
      WHERE id = NEW.connection_id AND workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND revision = NEW.connection_revision AND status != 'revocation_pending'))
    THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_connections_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  DELETE FROM provider_authorization_attempts WHERE workspace_id = NEW.workspace_id;
  UPDATE provider_connections SET lease_token = NULL, lease_until = NULL WHERE workspace_id = NEW.workspace_id;
END;
