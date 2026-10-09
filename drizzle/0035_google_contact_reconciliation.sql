CREATE TABLE `provider_field_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`source_link_id` integer NOT NULL,
	`fields` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_link_id`) REFERENCES `contact_provider_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_field_rules_source_idx` ON `provider_field_rules` (`workspace_id`,`source_link_id`);--> statement-breakpoint
ALTER TABLE `provider_contact_resources` ADD `sync_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_resources` ADD `sync_interval` integer DEFAULT 86400 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_resources` ADD `next_sync_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_resources` ADD `settings_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_runs` ADD `reconcile_after` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_runs` ADD `reconciled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_runs` ADD `reconcile_skipped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_contact_runs` ADD `schedule_revision` integer;
--> statement-breakpoint
CREATE TRIGGER provider_field_rules_validate_insert BEFORE INSERT ON provider_field_rules BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contact_provider_links l WHERE l.id = NEW.source_link_id AND l.workspace_id = NEW.workspace_id);
 SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR NOT json_valid(NEW.fields) OR length(CAST(NEW.fields AS BLOB)) > 131072;
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE json_type(NEW.fields) IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.fields)) != 2
   OR json_type(NEW.fields, '$.name') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.fields, '$.name')) != 4 OR json_type(NEW.fields, '$.methods') IS NOT 'array'
   OR json_array_length(NEW.fields, '$.methods') > 256 OR COALESCE(json_extract(NEW.fields, '$.name.mode'), '') NOT IN ('keep','follow')
   OR COALESCE(json_type(NEW.fields, '$.name.overridden'), '') NOT IN ('true','false')
   OR COALESCE(json_type(NEW.fields, '$.name.issue'), '') NOT IN ('null','text') OR COALESCE(json_extract(NEW.fields, '$.name.issue'), '') NOT IN ('','missing','ambiguous','invalid','capacity')
   OR COALESCE(json_type(NEW.fields, '$.name.last_applied'), '') NOT IN ('null','text') OR length(json_extract(NEW.fields, '$.name.last_applied')) > 200;
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') f
   WHERE f.type != 'object' OR (SELECT COUNT(*) FROM json_each(f.value)) != 7 OR length(json_extract(f.value, '$.id')) != 36
     OR COALESCE(json_extract(f.value, '$.kind'), '') NOT IN ('email','phone') OR COALESCE(json_extract(f.value, '$.mode'), '') NOT IN ('keep','follow')
     OR COALESCE(json_type(f.value, '$.overridden'), '') NOT IN ('true','false')
     OR COALESCE(json_type(f.value, '$.last_applied'), '') NOT IN ('text','null') OR length(json_extract(f.value, '$.last_applied')) > CASE WHEN json_extract(f.value, '$.kind') = 'email' THEN 320 ELSE 100 END
     OR COALESCE(json_type(f.value, '$.issue'), '') NOT IN ('null','text') OR COALESCE(json_extract(f.value, '$.issue'), '') NOT IN ('','missing','ambiguous','invalid','capacity')
     OR COALESCE(json_type(f.value, '$.slot'), '') NOT IN ('null','object')
     OR NOT EXISTS (SELECT 1 FROM contact_provider_links l, json_each(l.applied_fields, '$.methods') a WHERE l.id = NEW.source_link_id AND l.workspace_id = NEW.workspace_id
       AND json_extract(a.value, '$.method.id') = json_extract(f.value, '$.id') AND json_extract(a.value, '$.method.kind') = json_extract(f.value, '$.kind')));
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') GROUP BY json_extract(value, '$.id') HAVING COUNT(*) > 1);
 SELECT RAISE(ABORT, 'PROVIDER_RULE_AUTHORITY') WHERE EXISTS (SELECT 1 FROM provider_field_rules other JOIN contact_provider_links old_link ON old_link.id = other.source_link_id
   JOIN contact_provider_links new_link ON new_link.id = NEW.source_link_id AND new_link.workspace_id = NEW.workspace_id
   WHERE other.workspace_id = NEW.workspace_id AND other.source_link_id != NEW.source_link_id AND old_link.contact_id = new_link.contact_id
     AND (json_extract(NEW.fields, '$.name.mode') = 'follow' AND json_extract(other.fields, '$.name.mode') = 'follow'
       OR EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') f, json_each(other.fields, '$.methods') g
         WHERE json_extract(f.value, '$.id') = json_extract(g.value, '$.id') AND json_extract(f.value, '$.mode') = 'follow' AND json_extract(g.value, '$.mode') = 'follow')));
 
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_rules_bound_insert AFTER INSERT ON provider_field_rules BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('source_public_id', l.public_id, 'revision', r.revision, 'fields', json(r.fields))) AS BLOB))
   FROM provider_field_rules r JOIN contact_provider_links l ON l.id = r.source_link_id AND l.workspace_id = r.workspace_id
   WHERE r.workspace_id = NEW.workspace_id AND l.contact_id = (SELECT contact_id FROM contact_provider_links WHERE id = NEW.source_link_id)) > 131072;
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_rules_validate_update BEFORE UPDATE ON provider_field_rules BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contact_provider_links l WHERE l.id = NEW.source_link_id AND l.workspace_id = NEW.workspace_id);
 SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR NOT json_valid(NEW.fields) OR length(CAST(NEW.fields AS BLOB)) > 131072;
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE json_type(NEW.fields) IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.fields)) != 2
   OR json_type(NEW.fields, '$.name') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.fields, '$.name')) != 4 OR json_type(NEW.fields, '$.methods') IS NOT 'array'
   OR json_array_length(NEW.fields, '$.methods') > 256 OR COALESCE(json_extract(NEW.fields, '$.name.mode'), '') NOT IN ('keep','follow')
   OR COALESCE(json_type(NEW.fields, '$.name.overridden'), '') NOT IN ('true','false')
   OR COALESCE(json_type(NEW.fields, '$.name.issue'), '') NOT IN ('null','text') OR COALESCE(json_extract(NEW.fields, '$.name.issue'), '') NOT IN ('','missing','ambiguous','invalid','capacity')
   OR COALESCE(json_type(NEW.fields, '$.name.last_applied'), '') NOT IN ('null','text') OR length(json_extract(NEW.fields, '$.name.last_applied')) > 200;
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') f
   WHERE f.type != 'object' OR (SELECT COUNT(*) FROM json_each(f.value)) != 7 OR length(json_extract(f.value, '$.id')) != 36
     OR COALESCE(json_extract(f.value, '$.kind'), '') NOT IN ('email','phone') OR COALESCE(json_extract(f.value, '$.mode'), '') NOT IN ('keep','follow')
     OR COALESCE(json_type(f.value, '$.overridden'), '') NOT IN ('true','false')
     OR COALESCE(json_type(f.value, '$.last_applied'), '') NOT IN ('text','null') OR length(json_extract(f.value, '$.last_applied')) > CASE WHEN json_extract(f.value, '$.kind') = 'email' THEN 320 ELSE 100 END
     OR COALESCE(json_type(f.value, '$.issue'), '') NOT IN ('null','text') OR COALESCE(json_extract(f.value, '$.issue'), '') NOT IN ('','missing','ambiguous','invalid','capacity')
     OR COALESCE(json_type(f.value, '$.slot'), '') NOT IN ('null','object')
     OR NOT EXISTS (SELECT 1 FROM contact_provider_links l, json_each(l.applied_fields, '$.methods') a WHERE l.id = NEW.source_link_id AND l.workspace_id = NEW.workspace_id
       AND json_extract(a.value, '$.method.id') = json_extract(f.value, '$.id') AND json_extract(a.value, '$.method.kind') = json_extract(f.value, '$.kind')));
 SELECT RAISE(ABORT, 'PROVIDER_RULE_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') GROUP BY json_extract(value, '$.id') HAVING COUNT(*) > 1);
 SELECT RAISE(ABORT, 'PROVIDER_RULE_AUTHORITY') WHERE EXISTS (SELECT 1 FROM provider_field_rules other JOIN contact_provider_links old_link ON old_link.id = other.source_link_id
   JOIN contact_provider_links new_link ON new_link.id = NEW.source_link_id AND new_link.workspace_id = NEW.workspace_id
   WHERE other.workspace_id = NEW.workspace_id AND other.source_link_id != NEW.source_link_id AND old_link.contact_id = new_link.contact_id
     AND (json_extract(NEW.fields, '$.name.mode') = 'follow' AND json_extract(other.fields, '$.name.mode') = 'follow'
       OR EXISTS (SELECT 1 FROM json_each(NEW.fields, '$.methods') f, json_each(other.fields, '$.methods') g
         WHERE json_extract(f.value, '$.id') = json_extract(g.value, '$.id') AND json_extract(f.value, '$.mode') = 'follow' AND json_extract(g.value, '$.mode') = 'follow')));
 SELECT RAISE(ABORT, 'PROVIDER_RULE_IMMUTABLE') WHERE NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_link_id IS NOT OLD.source_link_id OR NEW.revision < OLD.revision;
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_rules_bound_update AFTER UPDATE ON provider_field_rules BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('source_public_id', l.public_id, 'revision', r.revision, 'fields', json(r.fields))) AS BLOB))
   FROM provider_field_rules r JOIN contact_provider_links l ON l.id = r.source_link_id AND l.workspace_id = r.workspace_id
   WHERE r.workspace_id = NEW.workspace_id AND l.contact_id = (SELECT contact_id FROM contact_provider_links WHERE id = NEW.source_link_id)) > 131072;
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_rules_recovery_delete AFTER DELETE ON provider_field_rules BEGIN
 UPDATE workspaces SET recovery_revision = recovery_revision + 1 WHERE id = OLD.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_user_override AFTER UPDATE OF name, contact_methods ON contacts
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0 AND (NEW.name IS NOT OLD.name OR NEW.contact_methods IS NOT OLD.contact_methods)
BEGIN
 UPDATE provider_field_rules SET fields = json_set(fields,
   '$.name.overridden', CASE WHEN json_extract(fields, '$.name.mode') = 'follow' AND json_extract(fields, '$.name.last_applied') IS NOT NEW.name THEN json('true') ELSE json(CASE WHEN json_extract(fields, '$.name.overridden') = 1 THEN 'true' ELSE 'false' END) END,
   '$.methods', json((SELECT json_group_array(json(CASE WHEN json_extract(f.value, '$.mode') = 'follow' AND NOT EXISTS
      (SELECT 1 FROM json_each(NEW.contact_methods) m WHERE json_extract(m.value, '$.id') = json_extract(f.value, '$.id')
       AND json_extract(m.value, '$.kind') = json_extract(f.value, '$.kind') AND json_extract(m.value, '$.value') IS json_extract(f.value, '$.last_applied'))
      THEN json_set(f.value, '$.overridden', json('true')) ELSE f.value END)) FROM json_each(fields, '$.methods') f))),
   revision = revision + 1, updated_at = CURRENT_TIMESTAMP
 WHERE workspace_id = NEW.workspace_id AND source_link_id IN (SELECT id FROM contact_provider_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.id)
   AND (json_extract(fields, '$.name.mode') = 'follow' AND json_extract(fields, '$.name.overridden') = 0 AND json_extract(fields, '$.name.last_applied') IS NOT NEW.name
     OR EXISTS (SELECT 1 FROM json_each(fields, '$.methods') f WHERE json_extract(f.value, '$.mode') = 'follow' AND json_extract(f.value, '$.overridden') = 0 AND NOT EXISTS
       (SELECT 1 FROM json_each(NEW.contact_methods) m WHERE json_extract(m.value, '$.id') = json_extract(f.value, '$.id')
        AND json_extract(m.value, '$.kind') = json_extract(f.value, '$.kind') AND json_extract(m.value, '$.value') IS json_extract(f.value, '$.last_applied'))));
END;
--> statement-breakpoint
CREATE TRIGGER provider_field_parent_guard BEFORE UPDATE OF contact_id ON contact_provider_links
WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_AUTHORITY') WHERE EXISTS (SELECT 1 FROM provider_field_rules own, provider_field_rules other
   JOIN contact_provider_links destination ON destination.id = other.source_link_id AND destination.workspace_id = other.workspace_id
   WHERE own.workspace_id = NEW.workspace_id AND own.source_link_id = NEW.id AND other.workspace_id = NEW.workspace_id
     AND destination.contact_id = NEW.contact_id AND other.source_link_id != NEW.id
     AND (json_extract(own.fields, '$.name.mode') = 'follow' AND json_extract(other.fields, '$.name.mode') = 'follow'
       OR EXISTS (SELECT 1 FROM json_each(own.fields, '$.methods') f, json_each(other.fields, '$.methods') g
         WHERE json_extract(f.value, '$.id') = json_extract(g.value, '$.id') AND json_extract(f.value, '$.mode') = 'follow' AND json_extract(g.value, '$.mode') = 'follow')));
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_schedule_insert BEFORE INSERT ON provider_contact_resources BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_SCHEDULE_INVALID') WHERE NEW.sync_enabled NOT IN (0,1) OR NEW.sync_interval NOT IN (3600,86400)
   OR typeof(NEW.next_sync_at) != 'integer' OR NEW.next_sync_at < 0 OR typeof(NEW.settings_revision) != 'integer' OR NEW.settings_revision < 1;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_schedule_update BEFORE UPDATE ON provider_contact_resources BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_SCHEDULE_INVALID') WHERE NEW.sync_enabled NOT IN (0,1) OR NEW.sync_interval NOT IN (3600,86400)
   OR typeof(NEW.next_sync_at) != 'integer' OR NEW.next_sync_at < 0 OR typeof(NEW.settings_revision) != 'integer' OR NEW.settings_revision < 1;
END;
--> statement-breakpoint
DROP TRIGGER provider_contact_run_guard;
--> statement-breakpoint
CREATE TRIGGER provider_contact_run_guard BEFORE INSERT ON provider_contact_runs BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NEW.mode NOT IN ('full', 'delta') OR NEW.phase NOT IN ('copy', 'fetch', 'reconcile')
    OR NEW.force_full NOT IN (0, 1) OR NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_members m
      ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
      JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id
        AND c.dataset_epoch = NEW.dataset_epoch AND c.authorization_revision = NEW.authorization_revision
        AND c.status = 'connected' AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active')
    THEN RAISE(ABORT, 'PROVIDER_CONTACTS_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_contact_schedule_run_guard BEFORE INSERT ON provider_contact_runs BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_SCHEDULE_CHANGED') WHERE NEW.schedule_revision IS NOT NULL AND NOT EXISTS
   (SELECT 1 FROM provider_contact_resources WHERE connection_id = NEW.connection_id AND sync_enabled = 1 AND settings_revision = NEW.schedule_revision);
END;

--> statement-breakpoint
CREATE TRIGGER provider_field_parent_bound AFTER UPDATE OF contact_id ON contact_provider_links
WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
 SELECT RAISE(ABORT, 'PROVIDER_RULE_LIMIT') WHERE (SELECT length(CAST(json_group_array(json_object('source_public_id', l.public_id, 'revision', r.revision, 'fields', json(r.fields))) AS BLOB))
   FROM provider_field_rules r JOIN contact_provider_links l ON l.id = r.source_link_id AND l.workspace_id = r.workspace_id
   WHERE r.workspace_id = NEW.workspace_id AND l.contact_id = NEW.contact_id) > 131072;
END;
