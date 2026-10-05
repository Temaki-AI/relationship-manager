-- Derived CRM identities let matching normalize Unicode in JavaScript while
-- keeping lookups indexed. A pending change prevents publishing stale matches.
-- Migration 46 enforced this with an unnamed UNIQUE constraint. Retain it and
-- give the ORM's equivalent index an explicit name for future schema snapshots.
CREATE UNIQUE INDEX provider_gmail_run_generation ON provider_gmail_runs(connection_id,generation);
--> statement-breakpoint
CREATE TABLE gmail_contact_directory (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  bootstrapped INTEGER NOT NULL DEFAULT 0 CHECK(bootstrapped IN (0,1)),
  progress_revision INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO gmail_contact_directory(workspace_id) SELECT id FROM workspaces;
--> statement-breakpoint
CREATE TABLE gmail_contact_directory_pending (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_public_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,contact_public_id)
);
--> statement-breakpoint
CREATE TABLE gmail_contact_directory_entries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  contact_public_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,email,contact_public_id)
);
--> statement-breakpoint
CREATE INDEX gmail_contact_directory_person ON gmail_contact_directory_entries(workspace_id,contact_public_id);
--> statement-breakpoint
CREATE TRIGGER gmail_directory_workspace AFTER INSERT ON workspaces BEGIN
  INSERT INTO gmail_contact_directory(workspace_id) VALUES(NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER gmail_directory_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO gmail_contact_directory_pending(workspace_id,contact_public_id) VALUES(NEW.workspace_id,NEW.public_id) ON CONFLICT DO NOTHING;
  UPDATE gmail_contact_directory SET revision = revision + 1 WHERE workspace_id = NEW.workspace_id;
END;
--> statement-breakpoint
CREATE TRIGGER gmail_directory_update AFTER UPDATE OF workspace_id,public_id,email,contact_methods,merge_aliases ON contacts
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.public_id IS NOT OLD.public_id OR NEW.email IS NOT OLD.email OR NEW.contact_methods IS NOT OLD.contact_methods OR NEW.merge_aliases IS NOT OLD.merge_aliases BEGIN
  DELETE FROM gmail_contact_directory_entries WHERE workspace_id IN(OLD.workspace_id,NEW.workspace_id) AND contact_public_id IN(OLD.public_id,NEW.public_id);
  INSERT INTO gmail_contact_directory_pending(workspace_id,contact_public_id) VALUES(OLD.workspace_id,OLD.public_id) ON CONFLICT DO NOTHING;
  INSERT INTO gmail_contact_directory_pending(workspace_id,contact_public_id) VALUES(NEW.workspace_id,OLD.public_id),(NEW.workspace_id,NEW.public_id) ON CONFLICT DO NOTHING;
  UPDATE gmail_contact_directory SET revision = revision + 1 WHERE workspace_id IN(OLD.workspace_id,NEW.workspace_id);
END;
--> statement-breakpoint
CREATE TRIGGER gmail_directory_delete AFTER DELETE ON contacts BEGIN
  DELETE FROM gmail_contact_directory_entries WHERE workspace_id = OLD.workspace_id AND contact_public_id = OLD.public_id;
  INSERT INTO gmail_contact_directory_pending(workspace_id,contact_public_id) SELECT OLD.workspace_id,OLD.public_id
    WHERE EXISTS(SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) ON CONFLICT DO NOTHING;
  UPDATE gmail_contact_directory SET revision = revision + 1 WHERE workspace_id = OLD.workspace_id;
END;
--> statement-breakpoint
CREATE TABLE provider_gmail_participants (
  connection_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  email TEXT NOT NULL,
  roles TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(connection_id,generation,message_id,email),
  FOREIGN KEY(connection_id,generation,message_id) REFERENCES provider_gmail_index(connection_id,generation,message_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX provider_gmail_participants_email ON provider_gmail_participants(connection_id,generation,email,received_at,message_id);
--> statement-breakpoint
INSERT INTO provider_gmail_participants(connection_id,generation,message_id,email,roles,received_at)
SELECT i.connection_id,i.generation,i.message_id,json_extract(p.value,'$.email'),json_extract(p.value,'$.roles'),i.received_at
  FROM provider_gmail_index i,json_each(i.facts,'$.participants') p;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_participants_insert AFTER INSERT ON provider_gmail_index BEGIN
  INSERT INTO provider_gmail_participants(connection_id,generation,message_id,email,roles,received_at)
    SELECT NEW.connection_id,NEW.generation,NEW.message_id,json_extract(p.value,'$.email'),json_extract(p.value,'$.roles'),NEW.received_at
      FROM json_each(NEW.facts,'$.participants') p;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_participant_guard BEFORE INSERT ON provider_gmail_participants BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM provider_gmail_index i,json_each(i.facts,'$.participants') p
    WHERE i.connection_id=NEW.connection_id AND i.generation=NEW.generation AND i.message_id=NEW.message_id
      AND i.received_at=NEW.received_at AND json_extract(p.value,'$.email')=NEW.email AND json_extract(p.value,'$.roles')=NEW.roles)
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_participant_immutable BEFORE UPDATE ON provider_gmail_participants BEGIN
  SELECT RAISE(ABORT,'PROVIDER_GMAIL_INVALID');
END;
--> statement-breakpoint
CREATE TABLE provider_gmail_matching (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_gmail_resources(connection_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO provider_gmail_matching(connection_id) SELECT connection_id FROM provider_gmail_resources;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_matching_insert AFTER INSERT ON provider_gmail_resources BEGIN
  INSERT INTO provider_gmail_matching(connection_id) VALUES(NEW.connection_id);
END;
--> statement-breakpoint
CREATE TABLE provider_gmail_match_rules (
  connection_id TEXT NOT NULL REFERENCES provider_gmail_matching(connection_id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 320),
  action TEXT NOT NULL CHECK(action IN('link','exclude')),
  target_public_id TEXT,
  candidate_basis TEXT NOT NULL CHECK(json_valid(candidate_basis) AND json_type(candidate_basis)='array' AND json_array_length(candidate_basis) <= 20),
  PRIMARY KEY(connection_id,email),
  CHECK((action='exclude' AND target_public_id IS NULL AND candidate_basis='[]') OR
        (action='link' AND length(target_public_id)=36 AND json_array_length(candidate_basis) BETWEEN 1 AND 20))
);
--> statement-breakpoint
CREATE INDEX provider_gmail_match_rules_person ON provider_gmail_match_rules(connection_id,target_public_id,email);
--> statement-breakpoint
CREATE TABLE provider_gmail_match_receipts (
  connection_id TEXT NOT NULL REFERENCES provider_gmail_matching(connection_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN('link','exclude','clear')),
  email TEXT NOT NULL,
  target_public_id TEXT,
  PRIMARY KEY(connection_id,operation_id)
);
--> statement-breakpoint
CREATE TRIGGER provider_gmail_matching_settings AFTER UPDATE OF choices,settings_revision ON provider_gmail_resources
WHEN NEW.choices IS NOT OLD.choices OR NEW.settings_revision IS NOT OLD.settings_revision BEGIN
  DELETE FROM provider_gmail_match_rules WHERE connection_id=NEW.connection_id;
  DELETE FROM provider_gmail_match_receipts WHERE connection_id=NEW.connection_id;
  UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=NEW.connection_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_rule_immutable BEFORE UPDATE ON provider_gmail_match_rules BEGIN
  SELECT RAISE(ABORT,'PROVIDER_GMAIL_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_receipt_immutable BEFORE UPDATE ON provider_gmail_match_receipts BEGIN
  SELECT RAISE(ABORT,'PROVIDER_GMAIL_INVALID');
END;
