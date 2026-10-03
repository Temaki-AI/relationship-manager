CREATE TABLE `birthday_email_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`occurrence` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_until` text,
	`sent_at` text,
	`provider_message_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `birthday_email_delivery_event_idx` ON `birthday_email_deliveries` (`workspace_id`,`user_id`,`contact_id`,`occurrence`);--> statement-breakpoint
CREATE INDEX `birthday_email_delivery_queue_idx` ON `birthday_email_deliveries` (`status`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE TABLE `birthday_email_scan_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`contact_id` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TRIGGER birthday_email_delivery_guard_insert BEFORE INSERT ON birthday_email_deliveries
WHEN NOT EXISTS (SELECT 1 FROM reminder_email_preferences WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND enabled = 1)
  OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id AND birthday IS NOT NULL)
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'CLOUD_BIRTHDAY_EMAIL_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER birthday_email_delivery_guard_update BEFORE UPDATE ON birthday_email_deliveries
WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'CLOUD_BIRTHDAY_EMAIL_INVALID'); END;
