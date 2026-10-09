ALTER TABLE provider_gmail_resources ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sync_enabled IN(0,1));
--> statement-breakpoint
ALTER TABLE provider_gmail_resources ADD COLUMN sync_interval INTEGER NOT NULL DEFAULT 86400 CHECK(sync_interval IN(3600,86400));
--> statement-breakpoint
ALTER TABLE provider_gmail_resources ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0 CHECK(sync_revision >= 0);
--> statement-breakpoint
ALTER TABLE provider_gmail_resources ADD COLUMN next_sync_at INTEGER NOT NULL DEFAULT 0 CHECK(next_sync_at >= 0);
--> statement-breakpoint
ALTER TABLE provider_gmail_resources ADD COLUMN repair_required INTEGER NOT NULL DEFAULT 0 CHECK(repair_required IN(0,1));
--> statement-breakpoint
ALTER TABLE provider_gmail_runs ADD COLUMN schedule_revision INTEGER CHECK(schedule_revision IS NULL OR schedule_revision >= 0);
--> statement-breakpoint
CREATE INDEX provider_gmail_due ON provider_gmail_resources(sync_enabled,next_sync_at,connection_id);
--> statement-breakpoint
CREATE INDEX provider_gmail_dispatch ON provider_gmail_runs(status,schedule_revision,updated_at,id);
--> statement-breakpoint
CREATE TRIGGER provider_gmail_schedule_update BEFORE UPDATE ON provider_gmail_resources BEGIN
  SELECT CASE WHEN NEW.sync_revision < OLD.sync_revision
    OR ((NEW.sync_enabled != OLD.sync_enabled OR NEW.sync_interval != OLD.sync_interval) AND NEW.sync_revision != OLD.sync_revision + 1)
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_run_schedule_update BEFORE UPDATE ON provider_gmail_runs BEGIN
  SELECT CASE WHEN NEW.schedule_revision IS NOT OLD.schedule_revision THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_run_schedule_insert BEFORE INSERT ON provider_gmail_runs WHEN NEW.schedule_revision IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM provider_gmail_resources r WHERE r.connection_id=NEW.connection_id
    AND r.sync_enabled=1 AND r.sync_revision=NEW.schedule_revision AND r.settings_revision=NEW.settings_revision)
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_schedule_choices_changed AFTER UPDATE OF choices,settings_revision ON provider_gmail_resources
WHEN NEW.choices IS NOT OLD.choices OR NEW.settings_revision != OLD.settings_revision BEGIN
  UPDATE provider_gmail_resources SET sync_enabled=0,sync_revision=sync_revision+1,next_sync_at=0,repair_required=0 WHERE connection_id=NEW.connection_id;
END;
