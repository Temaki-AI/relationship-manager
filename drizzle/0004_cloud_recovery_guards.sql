CREATE TRIGGER cloud_guard_conflict BEFORE INSERT ON cloud_maintenance_guards
WHEN NEW.allowed = 0
BEGIN SELECT RAISE(ABORT, 'CLOUD_RECOVERY_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER workspace_preferences_recovery_update AFTER UPDATE OF name, persona ON workspaces
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER cloud_guard_size BEFORE INSERT ON cloud_maintenance_guards
WHEN NEW.allowed = -1
BEGIN SELECT RAISE(ABORT, 'CLOUD_BACKUP_TOO_LARGE'); END;
--> statement-breakpoint
CREATE TRIGGER contacts_recovery_insert AFTER INSERT ON contacts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contacts_recovery_update AFTER UPDATE ON contacts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contacts_recovery_delete AFTER DELETE ON contacts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contacts_erasure_insert BEFORE INSERT ON contacts
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contacts_erasure_update BEFORE UPDATE ON contacts
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_recovery_insert AFTER INSERT ON contact_relationships
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_recovery_update AFTER UPDATE ON contact_relationships
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_recovery_delete AFTER DELETE ON contact_relationships
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_erasure_insert BEFORE INSERT ON contact_relationships
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_erasure_update BEFORE UPDATE ON contact_relationships
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_children_recovery_insert AFTER INSERT ON contact_children
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_children_recovery_update AFTER UPDATE ON contact_children
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_children_recovery_delete AFTER DELETE ON contact_children
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_children_erasure_insert BEFORE INSERT ON contact_children
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_children_erasure_update BEFORE UPDATE ON contact_children
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER interactions_recovery_insert AFTER INSERT ON interactions
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER interactions_recovery_update AFTER UPDATE ON interactions
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER interactions_recovery_delete AFTER DELETE ON interactions
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER interactions_erasure_insert BEFORE INSERT ON interactions
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER interactions_erasure_update BEFORE UPDATE ON interactions
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER reminders_recovery_insert AFTER INSERT ON reminders
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER reminders_recovery_update AFTER UPDATE ON reminders
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER reminders_recovery_delete AFTER DELETE ON reminders
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER reminders_erasure_insert BEFORE INSERT ON reminders
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER reminders_erasure_update BEFORE UPDATE ON reminders
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_recovery_insert AFTER INSERT ON contact_groups
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_recovery_update AFTER UPDATE ON contact_groups
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_recovery_delete AFTER DELETE ON contact_groups
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_erasure_insert BEFORE INSERT ON contact_groups
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_erasure_update BEFORE UPDATE ON contact_groups
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_recovery_insert AFTER INSERT ON contact_group_members
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_recovery_update AFTER UPDATE ON contact_group_members
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_recovery_delete AFTER DELETE ON contact_group_members
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_erasure_insert BEFORE INSERT ON contact_group_members
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_erasure_update BEFORE UPDATE ON contact_group_members
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_recovery_insert AFTER INSERT ON relationship_facts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_recovery_update AFTER UPDATE ON relationship_facts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_recovery_delete AFTER DELETE ON relationship_facts
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_erasure_insert BEFORE INSERT ON relationship_facts
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_erasure_update BEFORE UPDATE ON relationship_facts
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_recovery_insert AFTER INSERT ON integration_connections
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_recovery_update AFTER UPDATE ON integration_connections
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_recovery_delete AFTER DELETE ON integration_connections
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_erasure_insert BEFORE INSERT ON integration_connections
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_erasure_update BEFORE UPDATE ON integration_connections
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_recovery_insert AFTER INSERT ON sync_jobs
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_recovery_update AFTER UPDATE ON sync_jobs
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_recovery_delete AFTER DELETE ON sync_jobs
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_erasure_insert BEFORE INSERT ON sync_jobs
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_erasure_update BEFORE UPDATE ON sync_jobs
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER plans_recovery_insert AFTER INSERT ON plans
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER plans_recovery_update AFTER UPDATE ON plans
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER plans_recovery_delete AFTER DELETE ON plans
BEGIN UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id; END;
--> statement-breakpoint
CREATE TRIGGER plans_erasure_insert BEFORE INSERT ON plans
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER plans_erasure_update BEFORE UPDATE ON plans
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER cloud_backup_files_erasure_insert BEFORE INSERT ON cloud_backup_files
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER cloud_backup_pins_erasure_insert BEFORE INSERT ON cloud_backup_pins
WHEN (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
