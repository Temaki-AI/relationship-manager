DROP INDEX `cloud_snapshot_restore_one_active`;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_source` text DEFAULT 'target' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_snapshot_restore_one_active` ON `cloud_snapshot_restore_jobs` (`workspace_id`) WHERE "cloud_snapshot_restore_jobs"."state" NOT IN ('invalid', 'completed', 'rolled_back');