CREATE TABLE `calendar_event_people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_people_identity_idx` ON `calendar_event_people` (`workspace_id`,`event_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `calendar_event_people_contact_idx` ON `calendar_event_people` (`workspace_id`,`contact_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `calendar_event_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`plan_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_plans_plan_idx` ON `calendar_event_plans` (`workspace_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `calendar_event_plans_event_idx` ON `calendar_event_plans` (`workspace_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_key` text NOT NULL,
	`account_email` text NOT NULL,
	`calendar_key` text NOT NULL,
	`calendar_label` text NOT NULL,
	`calendar_time_zone` text NOT NULL,
	`external_id` text NOT NULL,
	`facts` text NOT NULL,
	`availability` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_public_idx` ON `calendar_events` (`workspace_id`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_source_idx` ON `calendar_events` (`workspace_id`,`provider`,`account_key`,`calendar_key`,`external_id`);
--> statement-breakpoint
CREATE TRIGGER calendar_events_insert_guard BEFORE INSERT ON calendar_events BEGIN
  SELECT CASE WHEN NEW.provider != 'google-calendar' OR NEW.revision < 1 OR NEW.availability NOT IN ('available', 'unavailable')
    OR length(NEW.account_key) > 512 OR length(NEW.external_id) > 1024 OR length(NEW.calendar_key) > 1024
    OR length(CAST(NEW.facts AS BLOB)) > 65536 OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object'
    OR json_extract(NEW.facts, '$.id') IS NOT NEW.external_id THEN RAISE(ABORT, 'CALENDAR_EVENT_INVALID') END;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_events_update_guard BEFORE UPDATE ON calendar_events BEGIN
  SELECT CASE WHEN NEW.provider != 'google-calendar' OR NEW.revision < 1 OR NEW.availability NOT IN ('available', 'unavailable')
    OR length(NEW.account_key) > 512 OR length(NEW.external_id) > 1024 OR length(NEW.calendar_key) > 1024
    OR length(CAST(NEW.facts AS BLOB)) > 65536 OR NOT json_valid(NEW.facts) OR json_type(NEW.facts) != 'object'
    OR json_extract(NEW.facts, '$.id') IS NOT NEW.external_id OR NEW.public_id IS NOT OLD.public_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.provider IS NOT OLD.provider OR NEW.account_key IS NOT OLD.account_key OR NEW.calendar_key IS NOT OLD.calendar_key OR NEW.external_id IS NOT OLD.external_id OR NEW.revision < OLD.revision THEN RAISE(ABORT, 'CALENDAR_EVENT_INVALID') END;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_people_insert_guard BEFORE INSERT ON calendar_event_people BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id) OR (SELECT COUNT(*) FROM calendar_event_people WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id) >= 20
    THEN RAISE(ABORT, 'CALENDAR_EVENT_LINK_INVALID') END;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_people_update_guard BEFORE UPDATE ON calendar_event_people BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id) OR NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.event_id IS NOT OLD.event_id
    THEN RAISE(ABORT, 'CALENDAR_EVENT_LINK_INVALID') END;
END;

--> statement-breakpoint
-- Restore temporarily opens lifecycle guards while sync stays paused. Preserve saved parent revisions.
CREATE TRIGGER calendar_event_people_insert_revision AFTER INSERT ON calendar_event_people
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = NEW.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_people_update_revision AFTER UPDATE ON calendar_event_people
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = NEW.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_people_delete_revision AFTER DELETE ON calendar_event_people
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = OLD.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.event_id AND workspace_id = OLD.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_plans_insert_guard BEFORE INSERT ON calendar_event_plans BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND workspace_id = NEW.workspace_id) OR (SELECT COUNT(*) FROM calendar_event_plans WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id) >= 20
    THEN RAISE(ABORT, 'CALENDAR_EVENT_LINK_INVALID') END;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_plans_update_guard BEFORE UPDATE ON calendar_event_plans BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND workspace_id = NEW.workspace_id) OR NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.event_id IS NOT OLD.event_id
    THEN RAISE(ABORT, 'CALENDAR_EVENT_LINK_INVALID') END;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_plans_insert_revision AFTER INSERT ON calendar_event_plans
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = NEW.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_plans_update_revision AFTER UPDATE ON calendar_event_plans
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = NEW.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_event_plans_delete_revision AFTER DELETE ON calendar_event_plans
WHEN EXISTS (SELECT 1 FROM workspaces w JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = OLD.workspace_id AND w.lifecycle = 'active' AND s.paused = 0) BEGIN
  UPDATE calendar_events SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.event_id AND workspace_id = OLD.workspace_id;
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_events_insert_recovery AFTER INSERT ON calendar_events
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active') BEGIN
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_events_update_recovery AFTER UPDATE ON calendar_events
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active') BEGIN
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;

--> statement-breakpoint
CREATE TRIGGER calendar_events_delete_recovery AFTER DELETE ON calendar_events
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id AND lifecycle = 'active') BEGIN
  UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id;
END;
