CREATE TABLE `cloud_backup_schedules` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_until` text,
	`last_success_at` text,
	`last_failure_code` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloud_backup_schedules_due_idx` ON `cloud_backup_schedules` (`next_attempt_at`,`lease_until`);--> statement-breakpoint
ALTER TABLE `cloud_backup_files` ADD `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
CREATE INDEX `cloud_backup_files_cleanup_idx` ON `cloud_backup_files` (`state`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER cloud_backup_schedule_guard_insert BEFORE INSERT ON cloud_backup_schedules
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'CLOUD_BACKUP_SCHEDULE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER cloud_backup_schedule_guard_update BEFORE UPDATE ON cloud_backup_schedules
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'CLOUD_BACKUP_SCHEDULE_INVALID'); END;
