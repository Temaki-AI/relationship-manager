CREATE TABLE `child_birthday_email_scan_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`child_id` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_id`) REFERENCES `contact_children`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
DROP INDEX `birthday_email_delivery_event_idx`;--> statement-breakpoint
ALTER TABLE `birthday_email_deliveries` ADD `child_id` integer REFERENCES contact_children(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `birthday_email_delivery_child_idx` ON `birthday_email_deliveries` (`child_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `birthday_email_delivery_event_idx` ON `birthday_email_deliveries` (`workspace_id`,`user_id`,`contact_id`,case when "child_id" is null then 0 else "child_id" end,`occurrence`);--> statement-breakpoint
DROP TRIGGER birthday_email_delivery_guard_insert;--> statement-breakpoint
DROP TRIGGER birthday_email_delivery_guard_update;--> statement-breakpoint
CREATE TRIGGER birthday_email_delivery_guard_insert BEFORE INSERT ON birthday_email_deliveries
WHEN NOT EXISTS (SELECT 1 FROM reminder_email_preferences WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND enabled = 1)
  OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id)
  OR (NEW.child_id IS NULL AND NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id AND birthday IS NOT NULL))
  OR (NEW.child_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contact_children WHERE id = NEW.child_id AND workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id AND birthday IS NOT NULL))
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'CLOUD_BIRTHDAY_EMAIL_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER birthday_email_delivery_guard_update BEFORE UPDATE ON birthday_email_deliveries
WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND workspace_id = NEW.workspace_id)
  OR (NEW.child_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contact_children WHERE id = NEW.child_id AND workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id))
  OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'CLOUD_BIRTHDAY_EMAIL_INVALID'); END;
