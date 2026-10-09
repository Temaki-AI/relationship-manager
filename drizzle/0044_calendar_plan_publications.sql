CREATE TABLE `calendar_plan_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`plan_public_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`creator_client_id` text NOT NULL,
	`follow_date` integer DEFAULT 0 NOT NULL,
	`last_plan_date` text,
	`last_etag` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`issue` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`confirmed_at` text,
	`lease_token` text,
	`lease_until` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_plan_publications_plan_idx` ON `calendar_plan_publications` (`workspace_id`,`plan_public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_plan_publications_event_idx` ON `calendar_plan_publications` (`workspace_id`,`connection_id`,`calendar_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `calendar_plan_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`request_json` text NOT NULL,
	`plan_fingerprint` text NOT NULL,
	`dataset_epoch` text NOT NULL,
	`authorization_revision` integer NOT NULL,
	`publication_revision` integer NOT NULL,
	`kind` text NOT NULL,
	`base_etag` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`issue` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `calendar_plan_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_plan_writes_current_idx` ON `calendar_plan_writes` (`publication_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER calendar_plan_publication_insert_guard BEFORE INSERT ON calendar_plan_publications BEGIN
  SELECT CASE WHEN length(NEW.id) != 36 OR length(NEW.plan_public_id) != 36 OR NEW.event_id != lower(replace(NEW.id, '-', ''))
    OR NEW.status != 'pending' OR NEW.follow_date != 0 OR NEW.revision != 1 OR NEW.confirmed_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM provider_connections c JOIN provider_owned_calendars owned ON owned.connection_id = c.id
      JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
      JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
      JOIN plans p ON p.workspace_id = c.workspace_id AND p.public_id = NEW.plan_public_id
      WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id AND c.purpose = 'calendar-publish'
        AND c.status = 'connected' AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner'
        AND owned.status = 'ready' AND owned.dataset_epoch = s.epoch AND owned.authorization_revision = c.authorization_revision
        AND owned.calendar_id = NEW.calendar_id AND json_extract(owned.request_json, '$.client_id') = NEW.creator_client_id)
    THEN RAISE(ABORT, 'CALENDAR_PUBLICATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_publication_update_guard BEFORE UPDATE ON calendar_plan_publications BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.connection_id IS NOT OLD.connection_id OR NEW.plan_public_id IS NOT OLD.plan_public_id OR NEW.calendar_id IS NOT OLD.calendar_id
    OR NEW.event_id IS NOT OLD.event_id OR NEW.creator_client_id IS NOT OLD.creator_client_id
    OR typeof(NEW.revision) != 'integer' OR NEW.revision < OLD.revision OR NEW.follow_date NOT IN (0, 1)
    OR NEW.status NOT IN ('pending', 'published', 'held', 'missing')
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
    THEN RAISE(ABORT, 'CALENDAR_PUBLICATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_write_insert_guard BEFORE INSERT ON calendar_plan_writes BEGIN
  SELECT CASE WHEN length(NEW.id) != 36 OR length(NEW.fingerprint) != 64 OR length(NEW.plan_fingerprint) != 64
    OR NEW.status != 'pending' OR NEW.attempts != 0 OR NEW.revision != 1 OR NEW.kind NOT IN ('create', 'update')
    OR NOT json_valid(NEW.request_json) OR json_type(NEW.request_json) != 'object' OR length(CAST(NEW.request_json AS BLOB)) > 16384
    OR NOT EXISTS (SELECT 1 FROM calendar_plan_publications p JOIN provider_connections c ON c.id = p.connection_id
      JOIN workspace_sync_state s ON s.workspace_id = p.workspace_id JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
      WHERE p.id = NEW.publication_id AND p.revision = NEW.publication_revision AND c.status = 'connected'
        AND c.authorization_revision = NEW.authorization_revision AND c.dataset_epoch = NEW.dataset_epoch
        AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND m.role = 'owner')
    THEN RAISE(ABORT, 'CALENDAR_PUBLICATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_write_update_guard BEFORE UPDATE ON calendar_plan_writes BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.publication_id IS NOT OLD.publication_id OR NEW.fingerprint IS NOT OLD.fingerprint
    OR NEW.request_json IS NOT OLD.request_json OR NEW.plan_fingerprint IS NOT OLD.plan_fingerprint OR NEW.dataset_epoch IS NOT OLD.dataset_epoch
    OR NEW.authorization_revision IS NOT OLD.authorization_revision OR NEW.publication_revision IS NOT OLD.publication_revision
    OR NEW.kind IS NOT OLD.kind OR NEW.base_etag IS NOT OLD.base_etag OR typeof(NEW.attempts) != 'integer' OR NEW.attempts < OLD.attempts
    OR typeof(NEW.revision) != 'integer' OR NEW.revision < OLD.revision
    OR NEW.status NOT IN ('pending', 'unknown', 'confirmed', 'conflict', 'held', 'discarded', 'superseded')
    OR (OLD.status IN ('discarded', 'superseded') AND NEW.status IS NOT OLD.status)
    THEN RAISE(ABORT, 'CALENDAR_PUBLICATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_connection_fence AFTER UPDATE OF status, authorization_revision, dataset_epoch ON provider_connections
WHEN NEW.purpose = 'calendar-publish' AND (NEW.status IS NOT OLD.status OR NEW.authorization_revision != OLD.authorization_revision OR NEW.dataset_epoch IS NOT OLD.dataset_epoch) BEGIN
  UPDATE calendar_plan_publications SET status = 'held', issue = 'authorization_changed', follow_date = 0, revision = revision + 1, lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.id;
  UPDATE calendar_plan_writes SET status = 'held', issue = 'authorization_changed', revision = revision + 1
    WHERE publication_id IN (SELECT id FROM calendar_plan_publications WHERE connection_id = NEW.id) AND status IN ('pending', 'unknown', 'held');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_dataset_fence AFTER UPDATE OF epoch, paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  UPDATE calendar_plan_publications SET status = 'held', issue = 'dataset_changed', follow_date = 0, revision = revision + 1, lease_token = NULL, lease_until = NULL WHERE workspace_id = NEW.workspace_id;
  UPDATE calendar_plan_writes SET status = 'held', issue = 'dataset_changed', revision = revision + 1
    WHERE publication_id IN (SELECT id FROM calendar_plan_publications WHERE workspace_id = NEW.workspace_id) AND status IN ('pending', 'unknown', 'held');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_setup_fence AFTER UPDATE OF status ON provider_owned_calendars WHEN NEW.status != OLD.status AND NEW.status != 'ready' BEGIN
  UPDATE calendar_plan_publications SET status = 'held', issue = 'calendar_access_changed', follow_date = 0, revision = revision + 1, lease_token = NULL, lease_until = NULL WHERE connection_id = NEW.connection_id;
  UPDATE calendar_plan_writes SET status = 'held', issue = 'calendar_access_changed', revision = revision + 1
    WHERE publication_id IN (SELECT id FROM calendar_plan_publications WHERE connection_id = NEW.connection_id) AND status IN ('pending', 'unknown', 'held');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_plan_link_removal_fence AFTER DELETE ON calendar_event_plans BEGIN
  UPDATE calendar_plan_publications SET follow_date = 0, status = 'held', issue = 'plan_link_changed', revision = revision + 1, lease_token = NULL, lease_until = NULL
    WHERE workspace_id = OLD.workspace_id AND plan_public_id = (SELECT public_id FROM plans WHERE id = OLD.plan_id AND workspace_id = OLD.workspace_id);
  UPDATE calendar_plan_writes SET status = 'held', issue = 'plan_link_changed', revision = revision + 1
    WHERE publication_id IN (SELECT id FROM calendar_plan_publications WHERE workspace_id = OLD.workspace_id AND plan_public_id = (SELECT public_id FROM plans WHERE id = OLD.plan_id AND workspace_id = OLD.workspace_id))
      AND status IN ('pending', 'unknown', 'held');
END;

--> statement-breakpoint
CREATE TRIGGER calendar_plan_removal_fence BEFORE DELETE ON plans BEGIN
  UPDATE calendar_plan_publications SET status = 'held', issue = 'plan_removed', follow_date = 0, revision = revision + 1, lease_token = NULL, lease_until = NULL
    WHERE workspace_id = OLD.workspace_id AND plan_public_id = OLD.public_id;
  UPDATE calendar_plan_writes SET status = 'held', issue = 'plan_removed', revision = revision + 1
    WHERE publication_id IN (SELECT id FROM calendar_plan_publications WHERE workspace_id = OLD.workspace_id AND plan_public_id = OLD.public_id)
      AND status IN ('pending', 'unknown', 'held');
END;
