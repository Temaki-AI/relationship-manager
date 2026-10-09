CREATE TABLE `contact_provider_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`provider` text NOT NULL,
	`account_key` text NOT NULL,
	`account_email` text NOT NULL,
	`external_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`original_facts` text NOT NULL,
	`observed_facts` text NOT NULL,
	`applied_fields` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_links_workspace_public_idx` ON `contact_provider_links` (`workspace_id`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_links_identity_idx` ON `contact_provider_links` (`workspace_id`,`provider`,`account_key`,`external_id`);--> statement-breakpoint
CREATE INDEX `provider_links_contact_idx` ON `contact_provider_links` (`workspace_id`,`contact_id`,`id`);
--> statement-breakpoint
DROP TRIGGER sync_contact_insert;
--> statement-breakpoint
CREATE TRIGGER sync_contact_insert AFTER INSERT ON contacts
BEGIN
  UPDATE contacts SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND c.contact_methods != 'null' AND c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;
--> statement-breakpoint
DROP TRIGGER sync_contact_update;
--> statement-breakpoint
CREATE TRIGGER sync_contact_update AFTER UPDATE ON contacts
WHEN NEW.contact_methods != 'null' AND OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND (NEW.name IS NOT OLD.name
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
  OR NEW.contact_methods IS NOT OLD.contact_methods
  OR NEW.merge_aliases IS NOT OLD.merge_aliases
  OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.photo_url IS NOT OLD.photo_url)
BEGIN
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;
--> statement-breakpoint
DROP TRIGGER source_links_touch_insert;
--> statement-breakpoint
CREATE TRIGGER source_links_touch_insert AFTER INSERT ON contact_source_links WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT length(CAST(json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END) AS BLOB)) FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.contact_id) > 1046528;
 SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'external_id', external_id, 'profile_url', profile_url, 'origin', origin, 'fields', fields, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_source_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
 UPDATE contacts SET source_revision = source_revision + 1 WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id;
END;
--> statement-breakpoint
DROP TRIGGER source_links_touch_update;
--> statement-breakpoint
CREATE TRIGGER source_links_touch_update AFTER UPDATE ON contact_source_links WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT length(CAST(json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END) AS BLOB)) FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.contact_id) > 1046528;
 SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'external_id', external_id, 'profile_url', profile_url, 'origin', origin, 'fields', fields, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_source_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
 UPDATE contacts SET source_revision = source_revision + 1 WHERE workspace_id = NEW.workspace_id AND (id = NEW.contact_id OR id = OLD.contact_id);
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_validate_insert BEFORE INSERT ON contact_provider_links BEGIN
  SELECT RAISE(ABORT, 'PROVIDER_LINK_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id);
  SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
  SELECT RAISE(ABORT, 'PROVIDER_LINK_INVALID') WHERE NEW.provider != 'google' OR NEW.status NOT IN ('available', 'unavailable')
    OR length(NEW.public_id) != 36 OR length(NEW.account_key) NOT BETWEEN 1 AND 255 OR length(NEW.external_id) NOT BETWEEN 1 AND 255
    OR typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR length(NEW.account_email) > 320 OR length(NEW.resource_name) > 255
    OR NOT json_valid(NEW.original_facts) OR NOT json_valid(NEW.observed_facts) OR NOT json_valid(NEW.applied_fields);
  SELECT RAISE(ABORT, 'PROVIDER_LINK_INVALID') WHERE json_type(NEW.original_facts) != 'object' OR json_type(NEW.observed_facts) != 'object' OR json_type(NEW.applied_fields) != 'object'
    OR length(CAST(NEW.original_facts AS BLOB)) > 24576 OR length(CAST(NEW.observed_facts AS BLOB)) > 24576 OR length(CAST(NEW.applied_fields AS BLOB)) > 65536
    OR json_extract(NEW.original_facts, '$.sourceId') IS NOT NEW.external_id OR json_extract(NEW.observed_facts, '$.sourceId') IS NOT NEW.external_id
    OR json_extract(NEW.observed_facts, '$.resourceName') IS NOT NEW.resource_name;
  SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT COUNT(*) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id AND id != NEW.id) >= 32;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_touch_insert AFTER INSERT ON contact_provider_links WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END) AS BLOB)) FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.contact_id) > 1046528;
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'account_email', account_email, 'external_id', external_id, 'resource_name', resource_name, 'original_facts', original_facts, 'observed_facts', observed_facts, 'applied_fields', applied_fields, 'status', status, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
 UPDATE contacts SET source_revision = source_revision + 1 WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_validate_update BEFORE UPDATE ON contact_provider_links BEGIN
  SELECT RAISE(ABORT, 'PROVIDER_LINK_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id);
  SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
  SELECT RAISE(ABORT, 'PROVIDER_LINK_INVALID') WHERE NEW.provider != 'google' OR NEW.status NOT IN ('available', 'unavailable')
    OR length(NEW.public_id) != 36 OR length(NEW.account_key) NOT BETWEEN 1 AND 255 OR length(NEW.external_id) NOT BETWEEN 1 AND 255
    OR typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR length(NEW.account_email) > 320 OR length(NEW.resource_name) > 255
    OR NOT json_valid(NEW.original_facts) OR NOT json_valid(NEW.observed_facts) OR NOT json_valid(NEW.applied_fields);
  SELECT RAISE(ABORT, 'PROVIDER_LINK_INVALID') WHERE json_type(NEW.original_facts) != 'object' OR json_type(NEW.observed_facts) != 'object' OR json_type(NEW.applied_fields) != 'object'
    OR length(CAST(NEW.original_facts AS BLOB)) > 24576 OR length(CAST(NEW.observed_facts AS BLOB)) > 24576 OR length(CAST(NEW.applied_fields AS BLOB)) > 65536
    OR json_extract(NEW.original_facts, '$.sourceId') IS NOT NEW.external_id OR json_extract(NEW.observed_facts, '$.sourceId') IS NOT NEW.external_id
    OR json_extract(NEW.observed_facts, '$.resourceName') IS NOT NEW.resource_name;
  SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT COUNT(*) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id AND id != NEW.id) >= 32;
  SELECT RAISE(ABORT, 'PROVIDER_LINK_IMMUTABLE') WHERE NEW.workspace_id IS NOT OLD.workspace_id OR NEW.public_id IS NOT OLD.public_id OR NEW.provider IS NOT OLD.provider OR NEW.account_key IS NOT OLD.account_key OR NEW.external_id IS NOT OLD.external_id OR NEW.original_facts IS NOT OLD.original_facts OR NEW.revision < OLD.revision;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_touch_update AFTER UPDATE ON contact_provider_links WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_object('source_revision', c.source_revision, 'contact_methods', c.contact_methods, 'name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'merge_aliases', c.merge_aliases, 'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'external_id', link.external_id, 'profile_url', link.profile_url, 'origin', link.origin, 'fields', link.fields, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_source_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM (SELECT json_object('public_id', link.public_id, 'provider', link.provider, 'account_key', link.account_key, 'account_email', link.account_email, 'external_id', link.external_id, 'resource_name', link.resource_name, 'original_facts', link.original_facts, 'observed_facts', link.observed_facts, 'applied_fields', link.applied_fields, 'status', link.status, 'revision', link.revision, 'observed_at', link.observed_at, 'created_at', link.created_at, 'updated_at', link.updated_at) AS projection FROM contact_provider_links link WHERE link.workspace_id = c.workspace_id AND link.contact_id = c.id ORDER BY link.id)), '[]') || '', 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END) AS BLOB)) FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.contact_id) > 1046528;
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'account_email', account_email, 'external_id', external_id, 'resource_name', resource_name, 'original_facts', original_facts, 'observed_facts', observed_facts, 'applied_fields', applied_fields, 'status', status, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
 UPDATE contacts SET source_revision = source_revision + 1 WHERE workspace_id = NEW.workspace_id AND (id = NEW.contact_id OR id = OLD.contact_id);
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_touch_delete AFTER DELETE ON contact_provider_links WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0 BEGIN
 UPDATE contacts SET source_revision = source_revision + 1 WHERE workspace_id = OLD.workspace_id AND id = OLD.contact_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_recovery_insert AFTER INSERT ON contact_provider_links BEGIN
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_recovery_update AFTER UPDATE ON contact_provider_links BEGIN
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_recovery_delete AFTER DELETE ON contact_provider_links BEGIN
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_payload_insert_bound BEFORE INSERT ON sync_contact_records
WHEN length(CAST(NEW.payload AS BLOB)) > 1046528 BEGIN SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT'); END;
--> statement-breakpoint
CREATE TRIGGER sync_contact_payload_update_bound BEFORE UPDATE OF payload ON sync_contact_records
WHEN length(CAST(NEW.payload AS BLOB)) > 1046528 BEGIN SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT'); END;
--> statement-breakpoint
CREATE TRIGGER provider_links_collection_insert_bound AFTER INSERT ON contact_provider_links BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'account_email', account_email, 'external_id', external_id, 'resource_name', resource_name, 'original_facts', original_facts, 'observed_facts', observed_facts, 'applied_fields', applied_fields, 'status', status, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
END;
--> statement-breakpoint
CREATE TRIGGER provider_links_collection_update_bound AFTER UPDATE ON contact_provider_links BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_LINK_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('public_id', public_id, 'provider', provider, 'account_key', account_key, 'account_email', account_email, 'external_id', external_id, 'resource_name', resource_name, 'original_facts', original_facts, 'observed_facts', observed_facts, 'applied_fields', applied_fields, 'status', status, 'revision', revision, 'observed_at', observed_at, 'created_at', created_at, 'updated_at', updated_at)) AS BLOB)) FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id) > 131072;
END;
