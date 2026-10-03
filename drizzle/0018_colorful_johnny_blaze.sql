CREATE TABLE `cloud_snapshot_read_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`capture_job_id` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`state` text DEFAULT 'reading' NOT NULL,
	`part_index` integer DEFAULT 0 NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`part_chain` text DEFAULT '' NOT NULL,
	`row_counts` text DEFAULT '{}' NOT NULL,
	`last_table_index` integer DEFAULT -1 NOT NULL,
	`last_cursor_key` text DEFAULT '' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`capture_job_id`) REFERENCES `cloud_snapshot_capture_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloud_snapshot_read_workspace_idx` ON `cloud_snapshot_read_jobs` (`workspace_id`,`capture_job_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_read_job_guard BEFORE INSERT ON cloud_snapshot_read_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_snapshot_capture_jobs capture
  JOIN workspaces workspace ON workspace.id = capture.workspace_id
  WHERE capture.id = NEW.capture_job_id AND capture.workspace_id = NEW.workspace_id
    AND capture.state = 'manifest_ready' AND capture.manifest_sha256 = NEW.manifest_sha256
    AND workspace.lifecycle = 'active'
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_read_job_identity_guard BEFORE UPDATE OF workspace_id, capture_job_id, manifest_sha256
ON cloud_snapshot_read_jobs
WHEN NEW.workspace_id <> OLD.workspace_id OR NEW.capture_job_id <> OLD.capture_job_id
  OR NEW.manifest_sha256 <> OLD.manifest_sha256
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
