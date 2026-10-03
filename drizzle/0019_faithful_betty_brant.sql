CREATE TABLE `cloud_snapshot_restore_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`target_capture_job_id` text NOT NULL,
	`target_read_job_id` text,
	`rollback_capture_job_id` text,
	`rollback_read_job_id` text,
	`base_revision` integer NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_capture_job_id`) REFERENCES `cloud_snapshot_capture_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_read_job_id`) REFERENCES `cloud_snapshot_read_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rollback_capture_job_id`) REFERENCES `cloud_snapshot_capture_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rollback_read_job_id`) REFERENCES `cloud_snapshot_read_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cloud_snapshot_restore_workspace_idx` ON `cloud_snapshot_restore_jobs` (`workspace_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_snapshot_restore_one_active` ON `cloud_snapshot_restore_jobs` (`workspace_id`) WHERE "cloud_snapshot_restore_jobs"."state" IN ('preparing', 'ready');
--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_restore_insert_guard BEFORE INSERT ON cloud_snapshot_restore_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces workspace JOIN cloud_snapshot_capture_jobs capture
    ON capture.workspace_id = workspace.id
  WHERE workspace.id = NEW.workspace_id AND workspace.lifecycle = 'active'
    AND workspace.recovery_revision = NEW.base_revision
    AND capture.id = NEW.target_capture_job_id AND capture.state = 'manifest_ready'
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_restore_links_guard BEFORE UPDATE OF target_read_job_id, rollback_capture_job_id, rollback_read_job_id ON cloud_snapshot_restore_jobs
WHEN (NEW.target_read_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_snapshot_read_jobs WHERE id = NEW.target_read_job_id
      AND workspace_id = NEW.workspace_id AND capture_job_id = NEW.target_capture_job_id
  )) OR (NEW.rollback_capture_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_snapshot_capture_jobs WHERE id = NEW.rollback_capture_job_id
      AND workspace_id = NEW.workspace_id AND revision = NEW.base_revision
  )) OR (NEW.rollback_read_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_snapshot_read_jobs WHERE id = NEW.rollback_read_job_id
      AND workspace_id = NEW.workspace_id AND capture_job_id = NEW.rollback_capture_job_id
  ))
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
