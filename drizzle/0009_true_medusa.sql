CREATE TABLE `daily_snoozes` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`reminder_id` integer,
	`until_date` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `daily_snoozes_until_idx` ON `daily_snoozes` (`workspace_id`,`until_date`,`id`);
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_tenant_insert BEFORE INSERT ON daily_snoozes
WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id)
  OR (NEW.reminder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reminders WHERE id = NEW.reminder_id AND workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id))
BEGIN SELECT RAISE(ABORT, 'CLOUD_TENANT_MISMATCH'); END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_tenant_update BEFORE UPDATE ON daily_snoozes
WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id)
  OR (NEW.reminder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reminders WHERE id = NEW.reminder_id AND workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id))
BEGIN SELECT RAISE(ABORT, 'CLOUD_TENANT_MISMATCH'); END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_erasure_insert BEFORE INSERT ON daily_snoozes
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_erasure_update BEFORE UPDATE ON daily_snoozes
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_recovery_insert AFTER INSERT ON daily_snoozes
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_recovery_update AFTER UPDATE ON daily_snoozes
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_recovery_delete AFTER DELETE ON daily_snoozes
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
