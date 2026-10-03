DROP INDEX `cloud_snapshot_restore_one_active`;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_table_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_chunk_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_row_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_part_chain` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_restore_jobs` ADD `apply_row_counts` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_snapshot_restore_one_active` ON `cloud_snapshot_restore_jobs` (`workspace_id`) WHERE "cloud_snapshot_restore_jobs"."state" NOT IN ('invalid', 'completed');