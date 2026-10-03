CREATE TABLE `reminder_email_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reminder_id` integer NOT NULL,
	`remind_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_until` text,
	`sent_at` text,
	`provider_message_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_email_delivery_event_idx` ON `reminder_email_deliveries` (`workspace_id`,`user_id`,`reminder_id`,`remind_at`);--> statement-breakpoint
CREATE INDEX `reminder_email_delivery_queue_idx` ON `reminder_email_deliveries` (`status`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE TABLE `reminder_email_preferences` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`enabled_at` text,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`quiet_start_hour` integer DEFAULT 22 NOT NULL,
	`quiet_end_hour` integer DEFAULT 8 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER reminder_email_preferences_guard_insert BEFORE INSERT ON reminder_email_preferences
WHEN NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
  OR NEW.quiet_start_hour NOT BETWEEN 0 AND 23 OR NEW.quiet_end_hour NOT BETWEEN 0 AND 23
BEGIN SELECT RAISE(ABORT, 'CLOUD_EMAIL_PREFERENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER reminder_email_preferences_guard_update BEFORE UPDATE ON reminder_email_preferences
WHEN NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
  OR NEW.quiet_start_hour NOT BETWEEN 0 AND 23 OR NEW.quiet_end_hour NOT BETWEEN 0 AND 23
BEGIN SELECT RAISE(ABORT, 'CLOUD_EMAIL_PREFERENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER reminder_email_deliveries_guard_insert BEFORE INSERT ON reminder_email_deliveries
WHEN NOT EXISTS (SELECT 1 FROM reminder_email_preferences WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM reminders WHERE id = NEW.reminder_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'CLOUD_EMAIL_DELIVERY_INVALID'); END;
