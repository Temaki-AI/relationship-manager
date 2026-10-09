CREATE TABLE `contact_merge_aliases` (
	`workspace_id` text NOT NULL,
	`public_id` text NOT NULL,
	`canonical_public_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `public_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_merge_aliases_target_idx` ON `contact_merge_aliases` (`workspace_id`,`canonical_public_id`);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `merge_aliases` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
DROP TRIGGER sync_contact_insert;
--> statement-breakpoint
CREATE TRIGGER sync_contact_insert AFTER INSERT ON contacts
BEGIN
  UPDATE contacts SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;

--> statement-breakpoint
DROP TRIGGER sync_contact_update;
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
  OR NEW.merge_aliases IS NOT OLD.merge_aliases
  OR NEW.photo_url IS NOT OLD.photo_url)
BEGIN
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;

--> statement-breakpoint
UPDATE sync_contact_records SET payload = json_set(payload, '$.merge_aliases', '[]') WHERE payload IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER contact_alias_validate_insert BEFORE INSERT ON contacts BEGIN

  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE json_valid(NEW.merge_aliases) != 1;
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE json_type(NEW.merge_aliases) != 'array' OR json_array_length(NEW.merge_aliases) > 10000;
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases)
    WHERE type != 'text' OR length(value) != 36 OR length(replace(value, '-', '')) != 32 OR value GLOB '*[^a-f0-9-]*'
      OR substr(value, 9, 1) != '-' OR substr(value, 14, 1) != '-' OR substr(value, 19, 1) != '-' OR substr(value, 24, 1) != '-'
      OR substr(value, 15, 1) NOT GLOB '[1-8]' OR substr(value, 20, 1) NOT GLOB '[89ab]' OR value = NEW.public_id);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT value FROM json_each(NEW.merge_aliases) GROUP BY value HAVING COUNT(*) > 1);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases) aliases
    JOIN contacts c ON c.workspace_id = NEW.workspace_id AND c.public_id = aliases.value AND c.id != NEW.id);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases) aliases
    JOIN contact_merge_aliases mapping ON mapping.workspace_id = NEW.workspace_id AND mapping.public_id = aliases.value
    JOIN contacts c ON c.workspace_id = mapping.workspace_id AND c.public_id = mapping.canonical_public_id AND c.id != NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER contact_alias_index_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO contact_merge_aliases (workspace_id, public_id, canonical_public_id) SELECT NEW.workspace_id, value, NEW.public_id FROM json_each(NEW.merge_aliases) WHERE true ON CONFLICT(workspace_id, public_id) DO UPDATE SET canonical_public_id = excluded.canonical_public_id;
END;
--> statement-breakpoint
CREATE TRIGGER contact_alias_validate_update BEFORE UPDATE OF merge_aliases ON contacts BEGIN

  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE json_valid(NEW.merge_aliases) != 1;
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE json_type(NEW.merge_aliases) != 'array' OR json_array_length(NEW.merge_aliases) > 10000;
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases)
    WHERE type != 'text' OR length(value) != 36 OR length(replace(value, '-', '')) != 32 OR value GLOB '*[^a-f0-9-]*'
      OR substr(value, 9, 1) != '-' OR substr(value, 14, 1) != '-' OR substr(value, 19, 1) != '-' OR substr(value, 24, 1) != '-'
      OR substr(value, 15, 1) NOT GLOB '[1-8]' OR substr(value, 20, 1) NOT GLOB '[89ab]' OR value = NEW.public_id);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT value FROM json_each(NEW.merge_aliases) GROUP BY value HAVING COUNT(*) > 1);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases) aliases
    JOIN contacts c ON c.workspace_id = NEW.workspace_id AND c.public_id = aliases.value AND c.id != NEW.id);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases) aliases
    JOIN contact_merge_aliases mapping ON mapping.workspace_id = NEW.workspace_id AND mapping.public_id = aliases.value
    JOIN contacts c ON c.workspace_id = mapping.workspace_id AND c.public_id = mapping.canonical_public_id AND c.id != NEW.id);
  SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_IMMUTABLE') WHERE COALESCE((SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id), 0) = 0 AND EXISTS (SELECT 1 FROM json_each(OLD.merge_aliases) old_alias WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.merge_aliases) current_alias WHERE current_alias.value = old_alias.value));
END;
--> statement-breakpoint
CREATE TRIGGER contact_alias_index_update AFTER UPDATE OF merge_aliases ON contacts BEGIN
  INSERT INTO contact_merge_aliases (workspace_id, public_id, canonical_public_id) SELECT NEW.workspace_id, value, NEW.public_id FROM json_each(NEW.merge_aliases) WHERE true ON CONFLICT(workspace_id, public_id) DO UPDATE SET canonical_public_id = excluded.canonical_public_id;
END;
--> statement-breakpoint
CREATE TRIGGER contact_alias_reserved_insert BEFORE INSERT ON contacts WHEN NEW.public_id != '' AND EXISTS
  (SELECT 1 FROM contact_merge_aliases WHERE workspace_id = NEW.workspace_id AND public_id = NEW.public_id)
BEGIN SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER contact_alias_reserved_update BEFORE UPDATE OF public_id ON contacts WHEN NEW.public_id != OLD.public_id AND EXISTS
  (SELECT 1 FROM contact_merge_aliases WHERE workspace_id = NEW.workspace_id AND public_id = NEW.public_id)
BEGIN SELECT RAISE(ABORT, 'CLOUD_CONTACT_ALIAS_IMMUTABLE'); END;
