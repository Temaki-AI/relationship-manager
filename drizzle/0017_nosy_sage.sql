ALTER TABLE `cloud_snapshot_capture_jobs` ADD `verify_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_capture_jobs` ADD `manifest_part_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_capture_jobs` ADD `manifest_chain` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_capture_jobs` ADD `manifest_sha256` text;--> statement-breakpoint
ALTER TABLE `cloud_snapshot_capture_jobs` ADD `manifest_bytes` integer;--> statement-breakpoint
CREATE TRIGGER cloud_snapshot_manifest_ready_guard BEFORE UPDATE OF state ON cloud_snapshot_capture_jobs
WHEN NEW.state = 'manifest_ready' AND (
  OLD.state <> 'awaiting_verification' OR NEW.verify_index <> NEW.chunk_count
  OR (NEW.chunk_count = 0 AND NEW.manifest_part_count <> 0)
  OR (NEW.chunk_count > 0 AND NEW.manifest_part_count < 1)
  OR NEW.manifest_sha256 IS NULL OR LENGTH(NEW.manifest_sha256) <> 64
  OR NEW.manifest_bytes IS NULL OR NEW.manifest_bytes < 1
  OR NOT EXISTS (SELECT 1 FROM workspaces workspace WHERE workspace.id = NEW.workspace_id
    AND workspace.lifecycle = 'active' AND workspace.recovery_revision = NEW.revision)
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER contacts_immutable_workspace BEFORE UPDATE OF workspace_id ON contacts
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER contact_groups_immutable_workspace BEFORE UPDATE OF workspace_id ON contact_groups
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER contact_relationships_immutable_workspace BEFORE UPDATE OF workspace_id ON contact_relationships
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER contact_children_immutable_workspace BEFORE UPDATE OF workspace_id ON contact_children
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER interactions_immutable_workspace BEFORE UPDATE OF workspace_id ON interactions
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER reminders_immutable_workspace BEFORE UPDATE OF workspace_id ON reminders
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER daily_snoozes_immutable_workspace BEFORE UPDATE OF workspace_id ON daily_snoozes
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER contact_group_members_immutable_workspace BEFORE UPDATE OF workspace_id ON contact_group_members
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER relationship_facts_immutable_workspace BEFORE UPDATE OF workspace_id ON relationship_facts
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER integration_connections_immutable_workspace BEFORE UPDATE OF workspace_id ON integration_connections
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER sync_jobs_immutable_workspace BEFORE UPDATE OF workspace_id ON sync_jobs
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER plans_immutable_workspace BEFORE UPDATE OF workspace_id ON plans
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
