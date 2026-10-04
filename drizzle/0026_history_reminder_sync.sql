-- Preserve integer IDs; sync identities and exact phone interaction timestamps are additive.
CREATE TABLE `sync_entity_records` (
	`workspace_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`public_id` text NOT NULL,
	`legacy_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`payload` text,
	`deleted_at` text,
	PRIMARY KEY(`workspace_id`, `entity_type`, `public_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_entities_bootstrap_idx` ON `sync_entity_records` (`workspace_id`,`deleted_at`,`entity_type`,`public_id`);--> statement-breakpoint
ALTER TABLE `interactions` ADD `public_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `interactions` ADD `occurred_at` text;--> statement-breakpoint
UPDATE interactions SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX `interactions_workspace_public_id_idx` ON `interactions` (`workspace_id`,`public_id`);--> statement-breakpoint
ALTER TABLE `reminders` ADD `public_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE reminders SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_workspace_public_id_idx` ON `reminders` (`workspace_id`,`public_id`);
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT item.workspace_id, 'interaction', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'date', item.date, 'occurred_at', item.occurred_at, 'type', item.type, 'summary', item.summary, 'notes', item.notes, 'created_at', item.created_at) FROM interactions item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id;
--> statement-breakpoint
CREATE TRIGGER sync_interaction_identity_immutable BEFORE UPDATE OF public_id, id ON interactions
WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id OR NEW.id != OLD.id)
BEGIN SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER sync_interaction_insert AFTER INSERT ON interactions
BEGIN
  UPDATE interactions SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'interaction', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'date', item.date, 'occurred_at', item.occurred_at, 'type', item.type, 'summary', item.summary, 'notes', item.notes, 'created_at', item.created_at), NULL FROM interactions item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id
    WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'interaction' AND r.public_id = (SELECT public_id FROM interactions WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_interaction_update AFTER UPDATE ON interactions
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND (NEW.contact_id IS NOT OLD.contact_id OR NEW.date IS NOT OLD.date OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.type IS NOT OLD.type OR NEW.summary IS NOT OLD.summary OR NEW.notes IS NOT OLD.notes OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'interaction', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'date', item.date, 'occurred_at', item.occurred_at, 'type', item.type, 'summary', item.summary, 'notes', item.notes, 'created_at', item.created_at), NULL FROM interactions item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id
    WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'interaction' AND r.public_id = (SELECT public_id FROM interactions WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_interaction_delete AFTER DELETE ON interactions
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'interaction' AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'delete', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = OLD.workspace_id AND r.entity_type = 'interaction' AND r.public_id = OLD.public_id;
END;
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT item.workspace_id, 'reminder', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'title', item.title, 'notes', item.notes, 'remind_at', item.remind_at, 'completed_at', item.completed_at, 'created_at', item.created_at) FROM reminders item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id;
--> statement-breakpoint
CREATE TRIGGER sync_reminder_identity_immutable BEFORE UPDATE OF public_id, id ON reminders
WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id OR NEW.id != OLD.id)
BEGIN SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER sync_reminder_insert AFTER INSERT ON reminders
BEGIN
  UPDATE reminders SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'reminder', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'title', item.title, 'notes', item.notes, 'remind_at', item.remind_at, 'completed_at', item.completed_at, 'created_at', item.created_at), NULL FROM reminders item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id
    WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'reminder' AND r.public_id = (SELECT public_id FROM reminders WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_reminder_update AFTER UPDATE ON reminders
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND (NEW.contact_id IS NOT OLD.contact_id OR NEW.title IS NOT OLD.title OR NEW.notes IS NOT OLD.notes OR NEW.remind_at IS NOT OLD.remind_at OR NEW.completed_at IS NOT OLD.completed_at OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'reminder', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'title', item.title, 'notes', item.notes, 'remind_at', item.remind_at, 'completed_at', item.completed_at, 'created_at', item.created_at), NULL FROM reminders item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id
    WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'reminder' AND r.public_id = (SELECT public_id FROM reminders WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_reminder_delete AFTER DELETE ON reminders
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'reminder' AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'delete', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = OLD.workspace_id AND r.entity_type = 'reminder' AND r.public_id = OLD.public_id;
END;
