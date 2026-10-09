-- Public IDs and a durable contact replica; CRM integer IDs remain unchanged.
CREATE TABLE `sync_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`epoch` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_changes_pull_idx` ON `sync_changes` (`workspace_id`,`epoch`,`sequence`);
--> statement-breakpoint
CREATE TABLE `sync_contact_records` (
	`workspace_id` text NOT NULL,
	`public_id` text NOT NULL,
	`legacy_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`payload` text,
	`deleted_at` text,
	PRIMARY KEY(`workspace_id`, `public_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_contacts_bootstrap_idx` ON `sync_contact_records` (`workspace_id`,`deleted_at`,`public_id`);
--> statement-breakpoint
CREATE TABLE `sync_mutation_receipts` (
	`workspace_id` text NOT NULL,
	`epoch` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`owner_token` text NOT NULL,
	`result` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `epoch`, `operation_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_sync_state` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `public_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE contacts SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_workspace_public_id_idx` ON `contacts` (`workspace_id`,`public_id`);
--> statement-breakpoint
INSERT INTO workspace_sync_state (workspace_id, epoch) SELECT id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) FROM workspaces;
--> statement-breakpoint
INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END) FROM contacts c;
--> statement-breakpoint
CREATE TRIGGER sync_workspace_insert AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_sync_state (workspace_id, epoch) VALUES (NEW.id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))));
END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_identity_immutable BEFORE UPDATE OF public_id, id ON contacts WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id
  OR NEW.id != OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_insert AFTER INSERT ON contacts
BEGIN
  UPDATE contacts SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_update AFTER UPDATE ON contacts
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND (NEW.name IS NOT OLD.name
  OR NEW.nickname IS NOT OLD.nickname
  OR NEW.email IS NOT OLD.email
  OR NEW.phone IS NOT OLD.phone
  OR NEW.birthday IS NOT OLD.birthday
  OR NEW.birthday_reminder_days IS NOT OLD.birthday_reminder_days
  OR NEW.how_we_met IS NOT OLD.how_we_met
  OR NEW.tags IS NOT OLD.tags
  OR NEW.notes IS NOT OLD.notes
  OR NEW.gift_ideas IS NOT OLD.gift_ideas
  OR NEW.custom_fields IS NOT OLD.custom_fields
  OR NEW.last_contacted IS NOT OLD.last_contacted
  OR NEW.contact_frequency IS NOT OLD.contact_frequency
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.updated_at IS NOT OLD.updated_at
  OR NEW.photo_url IS NOT OLD.photo_url)
BEGIN
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_delete AFTER DELETE ON contacts WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_contact_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP WHERE workspace_id = OLD.workspace_id AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'delete', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE r.legacy_id = OLD.id AND r.workspace_id = OLD.workspace_id AND r.public_id = (SELECT public_id FROM sync_contact_records WHERE workspace_id = OLD.workspace_id AND public_id = OLD.public_id);
END;
