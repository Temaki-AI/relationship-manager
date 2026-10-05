CREATE TABLE provider_gmail_resources (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  dataset_epoch TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL,
  settings_revision INTEGER NOT NULL DEFAULT 1,
  choices TEXT NOT NULL,
  active_generation TEXT,
  checkpoint TEXT,
  coverage TEXT NOT NULL DEFAULT 'none' CHECK(coverage IN ('none','scanned','limited')),
  window_start INTEGER,
  window_end INTEGER,
  last_downloaded_at TEXT
);
--> statement-breakpoint
CREATE TABLE provider_gmail_runs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES provider_gmail_resources(connection_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  dataset_epoch TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL,
  settings_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  generation TEXT NOT NULL,
  base_generation TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('full','incremental')),
  phase TEXT NOT NULL DEFAULT 'profile' CHECK(phase IN ('profile','list','metadata','history','history_metadata','publish')),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  history_start TEXT,
  history_checkpoint TEXT,
  label_position INTEGER NOT NULL DEFAULT 0,
  next_page TEXT,
  pages INTEGER NOT NULL DEFAULT 0 CHECK(pages BETWEEN 0 AND 200),
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed BETWEEN 0 AND 20000),
  limited INTEGER NOT NULL DEFAULT 0 CHECK(limited IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','complete','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  lease_token TEXT,
  lease_until INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  issue TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id,generation)
);
--> statement-breakpoint
CREATE UNIQUE INDEX provider_gmail_one_active_run ON provider_gmail_runs(connection_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX provider_gmail_runs_owner ON provider_gmail_runs(workspace_id,user_id,connection_id,created_at);
--> statement-breakpoint
CREATE TABLE provider_gmail_pending (
  run_id TEXT NOT NULL REFERENCES provider_gmail_runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('list','history')),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  PRIMARY KEY(run_id,phase,message_id)
);
--> statement-breakpoint
CREATE TABLE provider_gmail_index (
  connection_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  facts TEXT NOT NULL,
  PRIMARY KEY(connection_id,generation,message_id),
  FOREIGN KEY(connection_id,generation) REFERENCES provider_gmail_runs(connection_id,generation) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX provider_gmail_index_date ON provider_gmail_index(connection_id,generation,received_at,message_id);
--> statement-breakpoint
CREATE TABLE provider_gmail_pages (
  run_id TEXT NOT NULL REFERENCES provider_gmail_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  PRIMARY KEY(run_id,phase,token_hash)
);
--> statement-breakpoint
CREATE TRIGGER provider_gmail_resource_insert BEFORE INSERT ON provider_gmail_resources BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
    WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.user_id = NEW.user_id AND c.purpose = 'gmail'
      AND c.status = 'connected' AND c.authorization_revision = NEW.authorization_revision AND c.dataset_epoch = NEW.dataset_epoch
      AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner')
    OR NEW.settings_revision < 1 OR NOT json_valid(NEW.choices) OR length(CAST(NEW.choices AS BLOB)) > 16384
    OR json_type(NEW.choices,'$.label_ids') IS NOT 'array' OR json_array_length(NEW.choices,'$.label_ids') NOT BETWEEN 1 AND 20
    OR json_type(NEW.choices,'$.own_addresses') IS NOT 'array' OR json_array_length(NEW.choices,'$.own_addresses') NOT BETWEEN 1 AND 21
    OR coalesce(json_extract(NEW.choices,'$.mode'),'') NOT IN ('existing_people','review_inbox')
    OR json_type(NEW.choices,'$.past_days') IS NOT 'integer' OR json_extract(NEW.choices,'$.past_days') NOT BETWEEN 1 AND 90
    OR json_type(NEW.choices,'$.scan_limit') IS NOT 'integer' OR json_extract(NEW.choices,'$.scan_limit') NOT BETWEEN 100 AND 10000
    OR coalesce(json_type(NEW.choices,'$.retain_subject'),'') NOT IN ('true','false') THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_resource_update BEFORE UPDATE ON provider_gmail_resources BEGIN
  SELECT CASE WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.dataset_epoch IS NOT OLD.dataset_epoch OR NEW.authorization_revision != OLD.authorization_revision
    OR NEW.settings_revision < OLD.settings_revision OR NOT json_valid(NEW.choices) OR length(CAST(NEW.choices AS BLOB)) > 16384
    OR (NEW.choices IS NOT OLD.choices AND NEW.settings_revision != OLD.settings_revision + 1)
    OR json_type(NEW.choices,'$.label_ids') IS NOT 'array' OR json_array_length(NEW.choices,'$.label_ids') NOT BETWEEN 1 AND 20
    OR json_type(NEW.choices,'$.own_addresses') IS NOT 'array' OR json_array_length(NEW.choices,'$.own_addresses') NOT BETWEEN 1 AND 21
    OR coalesce(json_extract(NEW.choices,'$.mode'),'') NOT IN ('existing_people','review_inbox')
    OR json_type(NEW.choices,'$.past_days') IS NOT 'integer' OR json_extract(NEW.choices,'$.past_days') NOT BETWEEN 1 AND 90
    OR json_type(NEW.choices,'$.scan_limit') IS NOT 'integer' OR json_extract(NEW.choices,'$.scan_limit') NOT BETWEEN 100 AND 10000
    OR coalesce(json_type(NEW.choices,'$.retain_subject'),'') NOT IN ('true','false') THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_run_insert BEFORE INSERT ON provider_gmail_runs BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM provider_gmail_resources r JOIN provider_connections c ON c.id = r.connection_id
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
    WHERE r.connection_id = NEW.connection_id AND r.workspace_id = NEW.workspace_id AND r.user_id = NEW.user_id
      AND r.dataset_epoch = NEW.dataset_epoch AND r.authorization_revision = NEW.authorization_revision AND r.settings_revision = NEW.settings_revision
      AND r.active_generation IS NEW.base_generation AND c.purpose = 'gmail' AND c.status = 'connected' AND c.authorization_revision = NEW.authorization_revision
      AND c.dataset_epoch = NEW.dataset_epoch AND s.epoch = NEW.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner')
    OR NEW.window_start < 0 OR NEW.window_end < NEW.window_start OR NEW.window_end - NEW.window_start > 7776000000
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_run_update BEFORE UPDATE ON provider_gmail_runs BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.dataset_epoch IS NOT OLD.dataset_epoch OR NEW.authorization_revision != OLD.authorization_revision OR NEW.settings_revision != OLD.settings_revision
    OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.generation IS NOT OLD.generation OR NEW.base_generation IS NOT OLD.base_generation
    OR NEW.mode IS NOT OLD.mode OR NEW.window_start != OLD.window_start OR NEW.window_end < OLD.window_end
    OR NEW.window_end - NEW.window_start > 7779600000 OR NEW.revision < OLD.revision
    OR NEW.pages < OLD.pages OR NEW.processed < OLD.processed OR length(NEW.next_page) > 8192
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_index_insert BEFORE INSERT ON provider_gmail_index BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.facts) OR json_type(NEW.facts) IS NOT 'object' OR length(CAST(NEW.facts AS BLOB)) > 65536
    OR (SELECT count(*) FROM json_each(NEW.facts)) != 8 OR json_extract(NEW.facts,'$.id') IS NOT NEW.message_id
    OR json_extract(NEW.facts,'$.received_at') IS NOT NEW.received_at OR json_type(NEW.facts,'$.participants') IS NOT 'array'
    OR json_array_length(NEW.facts,'$.participants') > 100 OR coalesce(json_extract(NEW.facts,'$.direction'),'') NOT IN ('incoming','outgoing','unknown')
    OR coalesce(json_type(NEW.facts,'$.participants_incomplete'),'') NOT IN ('true','false')
    OR json_type(NEW.facts,'$.thread_id') IS NOT 'text' OR length(json_extract(NEW.facts,'$.thread_id')) NOT BETWEEN 1 AND 256
    OR coalesce(json_type(NEW.facts,'$.subject'),'') NOT IN ('text','null') OR length(json_extract(NEW.facts,'$.subject')) > 1024
    OR coalesce(json_type(NEW.facts,'$.message_id'),'') NOT IN ('text','null')
    OR length(json_extract(NEW.facts,'$.message_id')) > 512 OR NEW.observed_at < NEW.received_at
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts,'$.participants') p WHERE p.type IS NOT 'object'
      OR (SELECT count(*) FROM json_each(p.value)) != 2
      OR EXISTS(SELECT 1 FROM json_each(p.value) WHERE key NOT IN ('email','roles'))
      OR json_type(p.value,'$.email') IS NOT 'text' OR length(json_extract(p.value,'$.email')) NOT BETWEEN 3 AND 320
      OR json_extract(p.value,'$.email') IS NOT lower(json_extract(p.value,'$.email'))
      OR json_type(p.value,'$.roles') IS NOT 'array' OR json_array_length(p.value,'$.roles') NOT BETWEEN 1 AND 4
      OR EXISTS(SELECT 1 FROM json_each(p.value,'$.roles') WHERE type IS NOT 'text' OR value NOT IN ('from','to','cc','bcc'))
      OR (SELECT count(*) FROM json_each(p.value,'$.roles')) != (SELECT count(DISTINCT value) FROM json_each(p.value,'$.roles')))
    OR (SELECT count(*) FROM json_each(NEW.facts,'$.participants')) !=
      (SELECT count(DISTINCT json_extract(value,'$.email')) FROM json_each(NEW.facts,'$.participants'))
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts) WHERE key NOT IN
      ('id','thread_id','received_at','direction','participants','participants_incomplete','subject','message_id'))
    OR NOT EXISTS(SELECT 1 FROM provider_gmail_runs run JOIN provider_gmail_resources r ON r.connection_id = run.connection_id
      JOIN provider_connections c ON c.id = r.connection_id JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
      JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
      WHERE run.connection_id = NEW.connection_id AND run.generation = NEW.generation AND run.status = 'active'
        AND run.settings_revision = r.settings_revision AND run.authorization_revision = c.authorization_revision
        AND run.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active' AND c.status = 'connected' AND c.purpose = 'gmail' AND m.role = 'owner'
        AND NEW.received_at BETWEEN run.window_start AND run.window_end
        AND (json_extract(r.choices,'$.retain_subject') = 1 OR json_extract(NEW.facts,'$.subject') IS NULL)
        AND NOT EXISTS(SELECT 1 FROM json_each(NEW.facts,'$.participants') p JOIN json_each(r.choices,'$.own_addresses') a
          ON json_extract(p.value,'$.email') = a.value))
    THEN RAISE(ABORT,'PROVIDER_GMAIL_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_owner_changed AFTER UPDATE OF role ON workspace_members WHEN NEW.role != 'owner' BEGIN
  DELETE FROM provider_gmail_resources WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_owner_removed AFTER DELETE ON workspace_members BEGIN
  DELETE FROM provider_gmail_resources WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_index_immutable BEFORE UPDATE ON provider_gmail_index BEGIN
  SELECT RAISE(ABORT,'PROVIDER_GMAIL_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_choices_changed AFTER UPDATE OF choices,settings_revision ON provider_gmail_resources
WHEN NEW.choices IS NOT OLD.choices OR NEW.settings_revision != OLD.settings_revision BEGIN
  DELETE FROM provider_gmail_runs WHERE connection_id = NEW.connection_id;
  UPDATE provider_gmail_resources SET active_generation = NULL, checkpoint = NULL, coverage = 'none', window_start = NULL, window_end = NULL, last_downloaded_at = NULL WHERE connection_id = NEW.connection_id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_authorization_changed AFTER UPDATE OF status,authorization_revision ON provider_connections
WHEN NEW.purpose = 'gmail' AND (NEW.status != 'connected' OR NEW.authorization_revision != OLD.authorization_revision) BEGIN
  DELETE FROM provider_gmail_resources WHERE connection_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER provider_gmail_dataset_changed AFTER UPDATE OF epoch,paused ON workspace_sync_state
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.paused != OLD.paused BEGIN
  DELETE FROM provider_gmail_resources WHERE workspace_id = NEW.workspace_id;
END;
