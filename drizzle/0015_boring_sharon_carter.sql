CREATE TABLE `cloud_snapshot_capture_chunks` (
	`job_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`table_name` text NOT NULL,
	`cursor_key` text NOT NULL,
	`row_count` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`job_id`, `sequence`),
	FOREIGN KEY (`job_id`) REFERENCES `cloud_snapshot_capture_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloud_snapshot_capture_chunks_workspace_idx` ON `cloud_snapshot_capture_chunks` (`workspace_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `cloud_snapshot_capture_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text DEFAULT 'capturing' NOT NULL,
	`table_index` integer DEFAULT 0 NOT NULL,
	`cursor_key` text DEFAULT '' NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`row_counts` text DEFAULT '{}' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloud_snapshot_capture_workspace_idx` ON `cloud_snapshot_capture_jobs` (`workspace_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_capture_job_guard BEFORE INSERT ON cloud_snapshot_capture_jobs
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id
  AND lifecycle = 'active' AND recovery_revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_capture_chunk_guard BEFORE INSERT ON cloud_snapshot_capture_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_snapshot_capture_jobs job
  JOIN workspaces workspace ON workspace.id = job.workspace_id
  WHERE job.id = NEW.job_id AND job.workspace_id = NEW.workspace_id
    AND job.state = 'capturing' AND job.lease_token IS NOT NULL
    AND workspace.lifecycle = 'active' AND workspace.recovery_revision = job.revision
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
