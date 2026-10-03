CREATE TRIGGER contacts_maintenance_delete BEFORE DELETE ON contacts
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_groups_maintenance_delete BEFORE DELETE ON contact_groups
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_relationships_maintenance_delete BEFORE DELETE ON contact_relationships
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_children_maintenance_delete BEFORE DELETE ON contact_children
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER interactions_maintenance_delete BEFORE DELETE ON interactions
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER reminders_maintenance_delete BEFORE DELETE ON reminders
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER daily_snoozes_maintenance_delete BEFORE DELETE ON daily_snoozes
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER contact_group_members_maintenance_delete BEFORE DELETE ON contact_group_members
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER relationship_facts_maintenance_delete BEFORE DELETE ON relationship_facts
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER integration_connections_maintenance_delete BEFORE DELETE ON integration_connections
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER sync_jobs_maintenance_delete BEFORE DELETE ON sync_jobs
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
--> statement-breakpoint
CREATE TRIGGER plans_maintenance_delete BEFORE DELETE ON plans
WHEN (SELECT lifecycle FROM workspaces WHERE id = OLD.workspace_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING'); END;
