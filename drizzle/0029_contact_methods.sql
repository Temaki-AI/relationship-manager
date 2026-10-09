ALTER TABLE `contacts` ADD `contact_methods` text DEFAULT 'null' NOT NULL;
--> statement-breakpoint
UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'email', 'value', contacts.email, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'legacy', 'source_value', contacts.email, 'user_override', json('false')) AS item WHERE contacts.email IS NOT NULL AND trim(contacts.email) != ''
    UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'phone', 'value', contacts.phone, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'legacy', 'source_value', contacts.phone, 'user_override', json('false')) WHERE contacts.phone IS NOT NULL AND trim(contacts.phone) != '' 
    UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'email', 'value', value, 'label', NULL, 'country', NULL,
    'preferred', json('false'), 'source', 'legacy', 'source_value', value, 'user_override', json('false')) FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.vcard.additional_emails') ELSE '[]' END) WHERE type = 'text' AND trim(value) != ''
    UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'phone', 'value', value, 'label', NULL, 'country', NULL,
    'preferred', json('false'), 'source', 'legacy', 'source_value', value, 'user_override', json('false')) FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.vcard.additional_phones') ELSE '[]' END) WHERE type = 'text' AND trim(value) != ''
    UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'profile', 'value', value, 'label', key, 'country', NULL,
    'preferred', json('false'), 'source', 'legacy', 'source_value', value, 'user_override', json('false')) FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.social') ELSE '{}' END) WHERE type = 'text' AND trim(value) != ''
  ));
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS contact_methods_shape_insert BEFORE INSERT ON contacts BEGIN
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_valid(NEW.contact_methods) != 1;
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE (json_type(NEW.contact_methods) != 'array' AND NEW.contact_methods != 'null') OR json_array_length(NEW.contact_methods) > 256 OR length(CAST(NEW.contact_methods AS BLOB)) > 393216;
  
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT 1 FROM json_each(NEW.contact_methods)
    WHERE type != 'object' OR COALESCE(json_type(value, '$.id'), '') != 'text' OR length(json_extract(value, '$.id')) != 36
      OR length(replace(json_extract(value, '$.id'), '-', '')) != 32 OR json_extract(value, '$.id') GLOB '*[^a-f0-9-]*'
      OR substr(json_extract(value, '$.id'), 9, 1) != '-' OR substr(json_extract(value, '$.id'), 14, 1) != '-'
      OR substr(json_extract(value, '$.id'), 19, 1) != '-' OR substr(json_extract(value, '$.id'), 24, 1) != '-'
      OR substr(json_extract(value, '$.id'), 15, 1) NOT GLOB '[1-8]' OR substr(json_extract(value, '$.id'), 20, 1) NOT GLOB '[89ab]'
      OR COALESCE(json_extract(value, '$.kind'), '') NOT IN ('email', 'phone', 'profile')
      OR COALESCE(json_type(value, '$.value'), '') != 'text' OR length(trim(json_extract(value, '$.value'))) = 0
      OR length(json_extract(value, '$.value')) > CASE json_extract(value, '$.kind') WHEN 'email' THEN 320 WHEN 'phone' THEN 100 ELSE 2048 END
      OR COALESCE(json_type(value, '$.label'), '') NOT IN ('null', 'text') OR length(json_extract(value, '$.label')) > 80
      OR COALESCE(json_type(value, '$.country'), '') NOT IN ('null', 'text') OR (json_type(value, '$.country') = 'text'
        AND (json_extract(value, '$.kind') != 'phone' OR length(json_extract(value, '$.country')) != 2 OR json_extract(value, '$.country') GLOB '*[^A-Z]*'))
      OR COALESCE(json_type(value, '$.preferred'), '') NOT IN ('true', 'false')
      OR COALESCE(json_type(value, '$.user_override'), '') NOT IN ('true', 'false')
      OR COALESCE(json_extract(value, '$.source'), '') NOT IN ('manual', 'legacy')
      OR (json_extract(value, '$.source') = 'manual' AND (COALESCE(json_type(value, '$.source_value'), '') != 'null' OR json_extract(value, '$.user_override') != 1))
      OR (json_extract(value, '$.source') = 'legacy' AND COALESCE(json_type(value, '$.source_value'), '') != 'text'));
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.id') FROM json_each(NEW.contact_methods) GROUP BY json_extract(value, '$.id') HAVING COUNT(*) > 1);
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.kind') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.preferred') = 1 GROUP BY json_extract(value, '$.kind') HAVING COUNT(*) > 1);

END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS contact_methods_shape_update BEFORE UPDATE OF contact_methods ON contacts BEGIN
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_valid(NEW.contact_methods) != 1;
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_type(NEW.contact_methods) != 'array' OR json_array_length(NEW.contact_methods) > 256 OR length(CAST(NEW.contact_methods AS BLOB)) > 393216;
  
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT 1 FROM json_each(NEW.contact_methods)
    WHERE type != 'object' OR COALESCE(json_type(value, '$.id'), '') != 'text' OR length(json_extract(value, '$.id')) != 36
      OR length(replace(json_extract(value, '$.id'), '-', '')) != 32 OR json_extract(value, '$.id') GLOB '*[^a-f0-9-]*'
      OR substr(json_extract(value, '$.id'), 9, 1) != '-' OR substr(json_extract(value, '$.id'), 14, 1) != '-'
      OR substr(json_extract(value, '$.id'), 19, 1) != '-' OR substr(json_extract(value, '$.id'), 24, 1) != '-'
      OR substr(json_extract(value, '$.id'), 15, 1) NOT GLOB '[1-8]' OR substr(json_extract(value, '$.id'), 20, 1) NOT GLOB '[89ab]'
      OR COALESCE(json_extract(value, '$.kind'), '') NOT IN ('email', 'phone', 'profile')
      OR COALESCE(json_type(value, '$.value'), '') != 'text' OR length(trim(json_extract(value, '$.value'))) = 0
      OR length(json_extract(value, '$.value')) > CASE json_extract(value, '$.kind') WHEN 'email' THEN 320 WHEN 'phone' THEN 100 ELSE 2048 END
      OR COALESCE(json_type(value, '$.label'), '') NOT IN ('null', 'text') OR length(json_extract(value, '$.label')) > 80
      OR COALESCE(json_type(value, '$.country'), '') NOT IN ('null', 'text') OR (json_type(value, '$.country') = 'text'
        AND (json_extract(value, '$.kind') != 'phone' OR length(json_extract(value, '$.country')) != 2 OR json_extract(value, '$.country') GLOB '*[^A-Z]*'))
      OR COALESCE(json_type(value, '$.preferred'), '') NOT IN ('true', 'false')
      OR COALESCE(json_type(value, '$.user_override'), '') NOT IN ('true', 'false')
      OR COALESCE(json_extract(value, '$.source'), '') NOT IN ('manual', 'legacy')
      OR (json_extract(value, '$.source') = 'manual' AND (COALESCE(json_type(value, '$.source_value'), '') != 'null' OR json_extract(value, '$.user_override') != 1))
      OR (json_extract(value, '$.source') = 'legacy' AND COALESCE(json_type(value, '$.source_value'), '') != 'text'));
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.id') FROM json_each(NEW.contact_methods) GROUP BY json_extract(value, '$.id') HAVING COUNT(*) > 1);
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.kind') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.preferred') = 1 GROUP BY json_extract(value, '$.kind') HAVING COUNT(*) > 1);

END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS contact_methods_primary_insert AFTER INSERT ON contacts BEGIN
  UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT value AS item FROM json_each(CASE WHEN NEW.contact_methods = 'null' THEN '[]' ELSE NEW.contact_methods END) UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'email', 'value', NEW.email, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item WHERE NEW.email IS NOT NULL AND trim(NEW.email) != ''
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1) UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'phone', 'value', NEW.phone, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item WHERE NEW.phone IS NOT NULL AND trim(NEW.phone) != ''
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1)
    UNION ALL SELECT item FROM (SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'email', 'value', value, 'label', NULL, 'country', NULL,
    'preferred', json('false'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item FROM json_each(CASE WHEN json_valid(NEW.custom_fields) THEN json_extract(NEW.custom_fields, '$.vcard.additional_emails') ELSE '[]' END)
      WHERE NEW.contact_methods = 'null' AND type = 'text' AND trim(value) != ''
UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'phone', 'value', value, 'label', NULL, 'country', NULL,
    'preferred', json('false'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item FROM json_each(CASE WHEN json_valid(NEW.custom_fields) THEN json_extract(NEW.custom_fields, '$.vcard.additional_phones') ELSE '[]' END)
      WHERE NEW.contact_methods = 'null' AND type = 'text' AND trim(value) != ''
UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'profile', 'value', value, 'label', key, 'country', NULL,
    'preferred', json('false'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item FROM json_each(CASE WHEN json_valid(NEW.custom_fields) THEN json_extract(NEW.custom_fields, '$.social') ELSE '[]' END)
      WHERE NEW.contact_methods = 'null' AND type = 'text' AND trim(value) != '')
  )) WHERE id = NEW.id;
  UPDATE contacts SET email = (SELECT json_extract(value, '$.value') FROM json_each(contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1),
    phone = (SELECT json_extract(value, '$.value') FROM json_each(contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1) WHERE id = NEW.id AND contact_methods != '[]';
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS contact_methods_primary_update AFTER UPDATE OF email, phone ON contacts
WHEN NEW.contact_methods IS OLD.contact_methods AND (NEW.email IS NOT OLD.email OR NEW.phone IS NOT OLD.phone)
BEGIN
  UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT CASE WHEN json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1 AND NEW.email IS NOT OLD.email AND json_extract(value, '$.value') IS NOT NEW.email
    THEN json_set(value, '$.value', NEW.email, '$.user_override', json('true')) WHEN json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1 AND NEW.phone IS NOT OLD.phone AND json_extract(value, '$.value') IS NOT NEW.phone
    THEN json_set(value, '$.value', NEW.phone, '$.user_override', json('true')) ELSE value END AS item FROM json_each(NEW.contact_methods)
    WHERE NOT (json_extract(value, '$.preferred') = 1 AND ((json_extract(value, '$.kind') = 'email' AND (NEW.email IS NULL OR trim(NEW.email) = ''))
      OR (json_extract(value, '$.kind') = 'phone' AND (NEW.phone IS NULL OR trim(NEW.phone) = ''))))
    UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'email', 'value', NEW.email, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item WHERE NEW.email IS NOT NULL AND trim(NEW.email) != ''
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1) UNION ALL SELECT json_object('id', (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 'kind', 'phone', 'value', NEW.phone, 'label', NULL, 'country', NULL,
    'preferred', json('true'), 'source', 'manual', 'source_value', NULL, 'user_override', json('true')) AS item WHERE NEW.phone IS NOT NULL AND trim(NEW.phone) != ''
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1)
  )) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS contact_methods_scalar_update AFTER UPDATE OF contact_methods ON contacts WHEN NEW.contact_methods IS NOT OLD.contact_methods
BEGIN
  UPDATE contacts SET email = (SELECT json_extract(value, '$.value') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1),
    phone = (SELECT json_extract(value, '$.value') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1) WHERE id = NEW.id;
END;

--> statement-breakpoint
DROP TRIGGER sync_contact_insert;
--> statement-breakpoint
CREATE TRIGGER sync_contact_insert AFTER INSERT ON contacts
BEGIN
  UPDATE contacts SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'contact_methods', c.contact_methods, 'merge_aliases', c.merge_aliases, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
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
  OR NEW.photo_url IS NOT OLD.photo_url)
BEGIN
  INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload, deleted_at) SELECT c.workspace_id, c.public_id, c.id, 1, json_object('name', c.name, 'nickname', c.nickname, 'email', c.email, 'phone', c.phone, 'birthday', c.birthday, 'birthday_reminder_days', c.birthday_reminder_days, 'how_we_met', c.how_we_met, 'tags', c.tags, 'notes', c.notes, 'gift_ideas', c.gift_ideas, 'custom_fields', c.custom_fields, 'last_contacted', c.last_contacted, 'contact_frequency', c.contact_frequency, 'created_at', c.created_at, 'updated_at', c.updated_at, 'contact_methods', c.contact_methods, 'merge_aliases', c.merge_aliases, 'photo_available', CASE WHEN c.photo_url IS NOT NULL THEN 1 ELSE 0 END), NULL
    FROM contacts c WHERE c.id = NEW.id AND c.workspace_id = NEW.workspace_id
    ON CONFLICT(workspace_id, public_id) DO UPDATE SET revision = sync_contact_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload) SELECT r.workspace_id, state.epoch, 'contact', r.public_id, 'upsert', r.revision, r.payload
    FROM sync_contact_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id WHERE r.legacy_id = NEW.id AND r.workspace_id = NEW.workspace_id AND r.public_id = (SELECT public_id FROM contacts WHERE id = NEW.id AND workspace_id = NEW.workspace_id);
END;

--> statement-breakpoint
UPDATE sync_contact_records SET payload = json_set(payload, '$.contact_methods', (SELECT contact_methods FROM contacts c WHERE c.workspace_id = sync_contact_records.workspace_id AND c.public_id = sync_contact_records.public_id)) WHERE payload IS NOT NULL;
