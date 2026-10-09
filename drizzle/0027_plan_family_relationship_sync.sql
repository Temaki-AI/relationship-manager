-- Add shared identity without changing existing integer IDs, references or history.
ALTER TABLE contact_children ADD public_id text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE contact_children SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX children_workspace_public_id_idx ON contact_children (workspace_id, public_id);
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT item.workspace_id, 'family', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'linked_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.linked_contact_id AND linked.workspace_id = item.workspace_id), 'name', item.name, 'birthday', item.birthday, 'created_at', item.created_at, 'updated_at', item.updated_at) FROM contact_children item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id;
--> statement-breakpoint
CREATE TRIGGER sync_family_identity_immutable BEFORE UPDATE OF public_id, id, workspace_id ON contact_children
WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id OR NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER sync_family_insert AFTER INSERT ON contact_children
BEGIN
  UPDATE contact_children SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'family', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'linked_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.linked_contact_id AND linked.workspace_id = item.workspace_id), 'name', item.name, 'birthday', item.birthday, 'created_at', item.created_at, 'updated_at', item.updated_at), NULL FROM contact_children item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'family'
      AND r.public_id = (SELECT public_id FROM contact_children WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_family_update AFTER UPDATE ON contact_children
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
  AND (NEW.contact_id IS NOT OLD.contact_id OR NEW.linked_contact_id IS NOT OLD.linked_contact_id OR NEW.name IS NOT OLD.name OR NEW.birthday IS NOT OLD.birthday OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at)
BEGIN
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'family', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'linked_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.linked_contact_id AND linked.workspace_id = item.workspace_id), 'name', item.name, 'birthday', item.birthday, 'created_at', item.created_at, 'updated_at', item.updated_at), NULL FROM contact_children item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'family'
      AND r.public_id = (SELECT public_id FROM contact_children WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_family_delete AFTER DELETE ON contact_children
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'family' AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'delete', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = OLD.workspace_id AND r.entity_type = 'family' AND r.public_id = OLD.public_id;
END;
--> statement-breakpoint
ALTER TABLE contact_relationships ADD public_id text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE contact_relationships SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX relationships_workspace_public_id_idx ON contact_relationships (workspace_id, public_id);
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT item.workspace_id, 'relationship', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'related_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.related_contact_id AND linked.workspace_id = item.workspace_id), 'relationship_label', item.relationship_label, 'reciprocal_label', item.reciprocal_label, 'created_at', item.created_at) FROM contact_relationships item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id;
--> statement-breakpoint
CREATE TRIGGER sync_relationship_identity_immutable BEFORE UPDATE OF public_id, id, workspace_id ON contact_relationships
WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id OR NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER sync_relationship_insert AFTER INSERT ON contact_relationships
BEGIN
  UPDATE contact_relationships SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'relationship', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'related_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.related_contact_id AND linked.workspace_id = item.workspace_id), 'relationship_label', item.relationship_label, 'reciprocal_label', item.reciprocal_label, 'created_at', item.created_at), NULL FROM contact_relationships item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'relationship'
      AND r.public_id = (SELECT public_id FROM contact_relationships WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_relationship_update AFTER UPDATE ON contact_relationships
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
  AND (NEW.contact_id IS NOT OLD.contact_id OR NEW.related_contact_id IS NOT OLD.related_contact_id OR NEW.relationship_label IS NOT OLD.relationship_label OR NEW.reciprocal_label IS NOT OLD.reciprocal_label OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'relationship', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'related_contact_id', (SELECT public_id FROM contacts linked WHERE linked.id = item.related_contact_id AND linked.workspace_id = item.workspace_id), 'relationship_label', item.relationship_label, 'reciprocal_label', item.reciprocal_label, 'created_at', item.created_at), NULL FROM contact_relationships item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'relationship'
      AND r.public_id = (SELECT public_id FROM contact_relationships WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_relationship_delete AFTER DELETE ON contact_relationships
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'relationship' AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'delete', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = OLD.workspace_id AND r.entity_type = 'relationship' AND r.public_id = OLD.public_id;
END;
--> statement-breakpoint
ALTER TABLE plans ADD public_id text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE plans SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE public_id = '';
--> statement-breakpoint
CREATE UNIQUE INDEX plans_workspace_public_id_idx ON plans (workspace_id, public_id);
--> statement-breakpoint
INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT item.workspace_id, 'plan', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'type', item.type, 'planned_date', item.planned_date, 'summary', item.summary, 'notes', item.notes, 'completed_at', item.completed_at, 'created_at', item.created_at) FROM plans item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id;
--> statement-breakpoint
CREATE TRIGGER sync_plan_identity_immutable BEFORE UPDATE OF public_id, id, workspace_id ON plans
WHEN OLD.public_id != '' AND (NEW.public_id != OLD.public_id OR NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'SYNC_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER sync_plan_insert AFTER INSERT ON plans
BEGIN
  UPDATE plans SET public_id = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) WHERE id = NEW.id AND public_id = '';
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'plan', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'type', item.type, 'planned_date', item.planned_date, 'summary', item.summary, 'notes', item.notes, 'completed_at', item.completed_at, 'created_at', item.created_at), NULL FROM plans item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'plan'
      AND r.public_id = (SELECT public_id FROM plans WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_plan_update AFTER UPDATE ON plans
WHEN OLD.public_id != '' AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
  AND (NEW.contact_id IS NOT OLD.contact_id OR NEW.type IS NOT OLD.type OR NEW.planned_date IS NOT OLD.planned_date OR NEW.summary IS NOT OLD.summary OR NEW.notes IS NOT OLD.notes OR NEW.completed_at IS NOT OLD.completed_at OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload, deleted_at)
    SELECT item.workspace_id, 'plan', item.public_id, item.id, 1, json_object('contact_id', parent.public_id, 'type', item.type, 'planned_date', item.planned_date, 'summary', item.summary, 'notes', item.notes, 'completed_at', item.completed_at, 'created_at', item.created_at), NULL FROM plans item JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id WHERE item.id = NEW.id AND item.workspace_id = NEW.workspace_id
      AND (SELECT paused FROM workspace_sync_state WHERE workspace_id = NEW.workspace_id) = 0
    ON CONFLICT(workspace_id, entity_type, public_id) DO UPDATE SET revision = sync_entity_records.revision + 1, payload = excluded.payload, deleted_at = NULL;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'upsert', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = NEW.workspace_id AND r.entity_type = 'plan'
      AND r.public_id = (SELECT public_id FROM plans WHERE id = NEW.id AND workspace_id = NEW.workspace_id) AND state.paused = 0;
END;
--> statement-breakpoint
CREATE TRIGGER sync_plan_delete AFTER DELETE ON plans
WHEN (SELECT paused FROM workspace_sync_state WHERE workspace_id = OLD.workspace_id) = 0
BEGIN
  UPDATE sync_entity_records SET revision = revision + 1, payload = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'plan' AND public_id = OLD.public_id;
  INSERT INTO sync_changes (workspace_id, epoch, entity_type, entity_id, operation, revision, payload)
    SELECT r.workspace_id, state.epoch, r.entity_type, r.public_id, 'delete', r.revision, r.payload
    FROM sync_entity_records r JOIN workspace_sync_state state ON state.workspace_id = r.workspace_id
    WHERE r.workspace_id = OLD.workspace_id AND r.entity_type = 'plan' AND r.public_id = OLD.public_id;
END;
--> statement-breakpoint
