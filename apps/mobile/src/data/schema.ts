import { contactMethodsBackfillSql } from '../../../../packages/domain/src/contact-method-storage.ts';
export const MOBILE_DATABASE_NAME = 'bonds-mobile.db';
export const MOBILE_SCHEMA_VERSION = 16;

export const MOBILE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY NOT NULL,
    remote_id INTEGER UNIQUE,
    device_contact_id TEXT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    birthday TEXT,
    how_we_met TEXT,
    notes TEXT,
    last_contacted TEXT,
    contact_frequency INTEGER NOT NULL DEFAULT 14 CHECK (contact_frequency BETWEEN 1 AND 3650),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict'))
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY NOT NULL,
    remote_id INTEGER UNIQUE,
    contact_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'message', 'meetup', 'email')),
    occurred_at TEXT NOT NULL,
    summary TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY NOT NULL,
    remote_id INTEGER UNIQUE,
    contact_id TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    remind_at TEXT NOT NULL,
    completed_at TEXT,
    notification_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'interaction', 'reminder')),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    payload TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_device_contact
    ON contacts(device_contact_id)
    WHERE device_contact_id IS NOT NULL AND deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_contacts_active_name
    ON contacts(deleted_at, name COLLATE NOCASE, id);
  CREATE INDEX IF NOT EXISTS idx_contacts_attention
    ON contacts(deleted_at, last_contacted, contact_frequency);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact_date
    ON interactions(contact_id, deleted_at, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_reminders_open_due
    ON reminders(completed_at, deleted_at, remind_at, id);
  CREATE INDEX IF NOT EXISTS idx_reminders_contact_due
    ON reminders(contact_id, completed_at, deleted_at, remind_at, id);
  CREATE INDEX IF NOT EXISTS idx_sync_queue_due
    ON sync_queue(next_attempt_at, created_at, id);
`;

export const MOBILE_TODAY_SNOOZES_MIGRATION_SQL = `
  CREATE TABLE today_snoozes (
    kind TEXT NOT NULL CHECK (kind IN ('birthday', 'overdue', 'reminder')),
    target_id TEXT NOT NULL, contact_id TEXT NOT NULL,
    until_date TEXT, remote_until_date TEXT,
    PRIMARY KEY (kind, target_id)
  );
  CREATE TABLE today_snooze_queue (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('birthday', 'overdue', 'reminder')),
    target_id TEXT NOT NULL, contact_id TEXT NOT NULL,
    until_date TEXT, base_until_date TEXT, epoch TEXT, time_zone TEXT NOT NULL,
    depends_on TEXT, request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'conflict')),
    last_error_code TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_today_snooze_queue_target ON today_snooze_queue(kind, target_id, status);
  CREATE INDEX idx_today_snoozes_contact ON today_snoozes(contact_id, until_date);
`;

export const MOBILE_CALENDAR_CONTEXT_MIGRATION_SQL = `
  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    sort_at TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json))
  );
  CREATE INDEX idx_calendar_event_order ON calendar_events(sort_at, id);
`;

export const MOBILE_CALENDAR_LINKS_MIGRATION_SQL = `
  CREATE TABLE calendar_event_link_queue (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT UNIQUE NOT NULL,
    epoch TEXT NOT NULL,
    base_fingerprint TEXT NOT NULL CHECK (length(base_fingerprint) = 64),
    contact_ids TEXT NOT NULL CHECK (json_valid(contact_ids) AND json_type(contact_ids) = 'array' AND json_array_length(contact_ids) <= 20),
    plan_ids TEXT NOT NULL CHECK (json_valid(plan_ids) AND json_type(plan_ids) = 'array' AND json_array_length(plan_ids) <= 20),
    request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'conflict')),
    last_error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_calendar_link_queue ON calendar_event_link_queue(status, created_at, id);
`;

export const MOBILE_SYNC_MIGRATION_SQL = `
  ALTER TABLE sync_queue ADD COLUMN epoch TEXT;
  ALTER TABLE sync_queue ADD COLUMN base_revision INTEGER;
  ALTER TABLE sync_queue ADD COLUMN base_payload TEXT;
  ALTER TABLE sync_queue ADD COLUMN request_json TEXT;
  ALTER TABLE sync_queue ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'conflict'));
  ALTER TABLE sync_queue ADD COLUMN response_json TEXT;
  CREATE TABLE sync_remote_contacts (
    id TEXT PRIMARY KEY NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE TABLE sync_bootstrap_contacts (
    id TEXT PRIMARY KEY NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX idx_sync_queue_entity ON sync_queue(entity_type, entity_id, status);
`;

export const MOBILE_ENTITY_SYNC_MIGRATION_SQL = `
  CREATE TABLE interactions_v3 (
    id TEXT PRIMARY KEY NOT NULL, remote_id INTEGER UNIQUE, contact_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'message', 'meetup', 'email')),
    date TEXT NOT NULL, occurred_at TEXT, summary TEXT, notes TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );
  INSERT INTO interactions_v3 SELECT id, remote_id, contact_id, type, substr(occurred_at, 1, 10),
    occurred_at, summary, notes, created_at, updated_at, deleted_at, sync_state FROM interactions;
  DROP TABLE interactions;
  ALTER TABLE interactions_v3 RENAME TO interactions;
  CREATE INDEX idx_interactions_contact_date ON interactions(contact_id, deleted_at, date DESC, occurred_at DESC, id DESC);
  CREATE TABLE sync_remote_entities (
    entity_type TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(entity_type, id)
  );
  CREATE TABLE sync_bootstrap_entities (
    entity_type TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(entity_type, id)
  );
  -- Version 1 never sent reminder operations. Recover a known null completion base
  -- only when its own preceding local create is still queued; retain unknown bases.
  UPDATE sync_queue AS q SET base_payload = '{"completed_at":null}'
    WHERE q.entity_type = 'reminder' AND q.operation = 'update' AND q.base_payload IS NULL
      AND q.request_json IS NULL AND (SELECT count(*) FROM json_each(q.payload)) = 1
      AND json_type(q.payload, '$.completedAt') = 'text'
      AND EXISTS (SELECT 1 FROM sync_queue earlier WHERE earlier.entity_type = 'reminder'
        AND earlier.entity_id = q.entity_id AND earlier.operation = 'create' AND earlier.rowid < q.rowid);
`;

export const MOBILE_CONTEXT_SYNC_MIGRATION_SQL = `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY NOT NULL, remote_id INTEGER UNIQUE, contact_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'message', 'meetup', 'email')),
    planned_date TEXT NOT NULL, summary TEXT, notes TEXT, completed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_plans_contact_date ON plans(contact_id, deleted_at, planned_date, id);
  CREATE TABLE contact_children (
    id TEXT PRIMARY KEY NOT NULL, remote_id INTEGER UNIQUE, contact_id TEXT NOT NULL, linked_contact_id TEXT,
    name TEXT NOT NULL, birthday TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (linked_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_children_contact ON contact_children(contact_id, deleted_at, id);
  CREATE INDEX idx_children_linked ON contact_children(linked_contact_id, deleted_at, id);
  CREATE TABLE contact_relationships (
    id TEXT PRIMARY KEY NOT NULL, remote_id INTEGER UNIQUE, contact_id TEXT NOT NULL, related_contact_id TEXT NOT NULL,
    relationship_label TEXT NOT NULL, reciprocal_label TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (related_contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_relationships_contact ON contact_relationships(contact_id, deleted_at, id);
  CREATE INDEX idx_relationships_related ON contact_relationships(related_contact_id, deleted_at, id);
  ALTER TABLE interactions ADD source_plan_id TEXT REFERENCES plans(id);
  CREATE INDEX idx_interactions_source_plan ON interactions(source_plan_id, sync_state);
  CREATE TABLE sync_queue_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'family', 'interaction', 'plan', 'relationship', 'reminder')),
    entity_id TEXT NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    payload TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT, last_error_code TEXT, created_at TEXT NOT NULL,
    epoch TEXT, base_revision INTEGER, base_payload TEXT, request_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'conflict')), response_json TEXT
  );
  INSERT INTO sync_queue_v4 (rowid, id, entity_type, entity_id, operation, payload, attempt_count,
    next_attempt_at, last_error_code, created_at, epoch, base_revision, base_payload, request_json, status, response_json)
    SELECT rowid, id, entity_type, entity_id, operation, payload, attempt_count,
      next_attempt_at, last_error_code, created_at, epoch, base_revision, base_payload, request_json, status, response_json FROM sync_queue;
  DROP TABLE sync_queue;
  ALTER TABLE sync_queue_v4 RENAME TO sync_queue;
  CREATE INDEX idx_sync_queue_due ON sync_queue(next_attempt_at, created_at, id);
  CREATE INDEX idx_sync_queue_entity ON sync_queue(entity_type, entity_id, status);
`;

export const MOBILE_CONTACT_ALIAS_MIGRATION_SQL = `
  CREATE TABLE contact_aliases (id TEXT PRIMARY KEY NOT NULL, canonical_id TEXT NOT NULL CHECK (id <> canonical_id));
  CREATE INDEX idx_contact_aliases_target ON contact_aliases(canonical_id, id);
`;

export const MOBILE_CONTACT_METHODS_MIGRATION_SQL = `ALTER TABLE contacts ADD COLUMN contact_methods TEXT NOT NULL DEFAULT '[]';
${contactMethodsBackfillSql(false)}`;

export const MOBILE_CONTACT_SOURCES_MIGRATION_SQL = `ALTER TABLE contacts ADD COLUMN source_links TEXT NOT NULL DEFAULT '[]';`;
export const MOBILE_PROVIDER_SOURCES_MIGRATION_SQL = `ALTER TABLE contacts ADD COLUMN provider_links TEXT NOT NULL DEFAULT '[]';`;

export const MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL = `
  CREATE TABLE device_contact_previews (
    id TEXT PRIMARY KEY NOT NULL, facts TEXT NOT NULL, created_at TEXT NOT NULL,
    fingerprint TEXT, source_id TEXT, contact_id TEXT, epoch TEXT
  );
  CREATE TABLE device_contact_links (
    id TEXT PRIMARY KEY NOT NULL, device_contact_id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    original_facts TEXT NOT NULL, observed_facts TEXT NOT NULL, applied_fields TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_device_contact_links_person ON device_contact_links(contact_id, id);
`;

export const MOBILE_DEVICE_SOURCE_SYNC_MIGRATION_SQL = `
  ALTER TABLE contacts ADD COLUMN device_links TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE device_contact_previews ADD COLUMN installation_id TEXT;
  ALTER TABLE device_contact_links RENAME TO device_contact_links_v9;
  DROP INDEX idx_device_contact_links_person;
  CREATE TABLE device_contact_links (
    id TEXT PRIMARY KEY NOT NULL, device_contact_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    installation_id TEXT, shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0, 1)), cloud_revision INTEGER,
    original_facts TEXT NOT NULL, observed_facts TEXT NOT NULL, applied_fields TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1), observed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO device_contact_links (id, device_contact_id, contact_id, original_facts, observed_facts, applied_fields, revision, observed_at, created_at, updated_at)
    SELECT id, device_contact_id, contact_id, original_facts, observed_facts, applied_fields, revision, observed_at, created_at, updated_at FROM device_contact_links_v9;
  DROP TABLE device_contact_links_v9;
  CREATE UNIQUE INDEX idx_device_contact_links_identity ON device_contact_links(installation_id, device_contact_id);
  CREATE INDEX idx_device_contact_links_person ON device_contact_links(contact_id, id);
  CREATE TABLE device_source_queue (
    id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, contact_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('publish', 'unlink')),
    payload TEXT NOT NULL, epoch TEXT, base_revision INTEGER, depends_on TEXT, request_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'conflict')), last_error_code TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_device_source_queue_source ON device_source_queue(source_id, id);
`;

export const MOBILE_DEVICE_CONTACT_POLICY_MIGRATION_SQL = `
  CREATE TABLE device_contact_policies (
    source_id TEXT PRIMARY KEY NOT NULL REFERENCES device_contact_links(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    fields TEXT NOT NULL, epoch TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    state TEXT NOT NULL DEFAULT 'idle', reason TEXT, last_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TRIGGER device_policy_after_move AFTER UPDATE OF contact_id ON device_contact_links
  WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
    UPDATE device_contact_policies SET enabled = 0, contact_id = NEW.contact_id, state = 'needs_review', reason = 'merged',
      revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE source_id = NEW.id;
  END;
  CREATE TRIGGER device_policy_after_edit AFTER UPDATE OF name, contact_methods ON contacts
  WHEN NEW.name IS NOT OLD.name OR NEW.contact_methods IS NOT OLD.contact_methods BEGIN
    UPDATE device_contact_policies SET fields = json_set(fields,
      '$.name.overridden', json(CASE WHEN json_extract(fields, '$.name.overridden') = 1
        OR json_extract(fields, '$.name.mode') = 'follow' AND json_extract(fields, '$.name.last_applied') IS NOT NEW.name THEN 'true' ELSE 'false' END),
      '$.methods', json(COALESCE((SELECT json_group_array(json(json_set(rule.value, '$.overridden',
        json(CASE WHEN json_extract(rule.value, '$.overridden') = 1 OR json_extract(rule.value, '$.mode') = 'follow' AND NOT EXISTS
          (SELECT 1 FROM json_each(NEW.contact_methods) method WHERE json_extract(method.value, '$.id') = json_extract(rule.value, '$.id')
            AND json_extract(method.value, '$.kind') = json_extract(rule.value, '$.kind')
            AND json_extract(method.value, '$.value') IS json_extract(rule.value, '$.last_applied')) THEN 'true' ELSE 'false' END))))
        FROM json_each(fields, '$.methods') rule), '[]'))),
      revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE source_id IN (SELECT id FROM device_contact_links WHERE contact_id = NEW.id);
  END;
`;


export const MOBILE_APPLE_CALENDAR_MIGRATION_SQL = `
  CREATE TABLE apple_calendar_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    account_scope TEXT NOT NULL,
    epoch TEXT,
    plan_id TEXT NOT NULL,
    plan_fingerprint TEXT NOT NULL CHECK (length(plan_fingerprint) = 64),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    attempted INTEGER NOT NULL DEFAULT 0 CHECK (attempted IN (0, 1)),
    event_id TEXT,
    calendar_id TEXT,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'unknown', 'saved', 'verified', 'cancelled', 'held', 'missing', 'discarded')),
    issue TEXT,
    facts TEXT CHECK (facts IS NULL OR json_valid(facts)),
    follow_date INTEGER NOT NULL DEFAULT 0 CHECK (follow_date IN (0, 1)),
    read_enabled INTEGER NOT NULL DEFAULT 0 CHECK (read_enabled IN (0, 1)),
    read_epoch TEXT,
    last_plan_date TEXT,
    last_read_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (status != 'prepared' OR attempted = 0),
    CHECK (status != 'discarded' OR attempted = 0),
    CHECK (read_enabled = 0 OR (attempted = 1 AND status = 'verified' AND event_id IS NOT NULL AND calendar_id IS NOT NULL AND facts IS NOT NULL)),
    CHECK (follow_date = 0 OR read_enabled = 1)
  );
  CREATE UNIQUE INDEX idx_apple_calendar_live_plan ON apple_calendar_receipts(plan_id) WHERE status NOT IN ('cancelled', 'discarded');
  CREATE INDEX idx_apple_calendar_reads ON apple_calendar_receipts(read_enabled, last_read_at, id);
  CREATE TRIGGER apple_calendar_receipt_insert BEFORE INSERT ON apple_calendar_receipts BEGIN
    SELECT CASE WHEN NEW.account_scope IS NOT (SELECT value FROM app_metadata WHERE key = 'account-scope')
      OR NEW.status != 'prepared' OR NEW.attempted != 0 OR NEW.revision != 1 THEN RAISE(ABORT, 'APPLE_CALENDAR_RECEIPT_INVALID') END;
  END;
  CREATE TRIGGER apple_calendar_receipt_guard BEFORE UPDATE ON apple_calendar_receipts BEGIN
    SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.account_scope IS NOT OLD.account_scope OR NEW.epoch IS NOT OLD.epoch
      OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_fingerprint IS NOT OLD.plan_fingerprint OR NEW.request_json IS NOT OLD.request_json
      OR NEW.attempted < OLD.attempted OR NEW.revision < OLD.revision OR NEW.status = 'discarded' AND NEW.attempted != 0 OR NEW.status = 'prepared' AND NEW.attempted != 0
      OR OLD.status IN ('cancelled', 'discarded') AND NEW.status IS NOT OLD.status THEN RAISE(ABORT, 'APPLE_CALENDAR_RECEIPT_INVALID') END;
  END;
  CREATE TRIGGER apple_calendar_plan_removed AFTER UPDATE OF deleted_at, completed_at ON plans
    WHEN NEW.deleted_at IS NOT NULL OR NEW.completed_at IS NOT NULL BEGIN
    UPDATE apple_calendar_receipts SET status = CASE WHEN status IN ('cancelled', 'discarded') THEN status ELSE 'held' END,
      issue = 'plan_unavailable', follow_date = 0, read_enabled = 0, revision = revision + 1 WHERE plan_id = NEW.id AND status NOT IN ('cancelled', 'discarded');
  END;
  CREATE TRIGGER apple_calendar_plan_deleted BEFORE DELETE ON plans BEGIN
    UPDATE apple_calendar_receipts SET status = 'held', issue = 'plan_unavailable', follow_date = 0, read_enabled = 0, revision = revision + 1
      WHERE plan_id = OLD.id AND status NOT IN ('cancelled', 'discarded');
  END;
  CREATE TRIGGER apple_calendar_plan_date_changed AFTER UPDATE OF planned_date ON plans WHEN NEW.planned_date IS NOT OLD.planned_date BEGIN
    UPDATE apple_calendar_receipts SET follow_date = 0, issue = 'date_following_suspended', revision = revision + 1
      WHERE plan_id = NEW.id AND follow_date = 1 AND last_plan_date IS NOT NEW.planned_date;
  END;
`;

export const MOBILE_GMAIL_CONTEXT_MIGRATION_SQL = `
  CREATE TABLE gmail_context_state (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
    revision INTEGER NOT NULL DEFAULT 0, manifest TEXT CHECK(manifest IS NULL OR json_valid(manifest)), checked_at INTEGER
  );
  INSERT INTO gmail_context_state(id) VALUES(1);
  CREATE TABLE gmail_person_context (
    source_id TEXT NOT NULL, person_id TEXT NOT NULL, scope TEXT NOT NULL,
    messages TEXT NOT NULL CHECK(json_valid(messages) AND json_type(messages)='array'),
    next TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY(source_id,person_id)
  );
  CREATE INDEX gmail_person_context_lru ON gmail_person_context(checked_at,source_id,person_id);
  CREATE TRIGGER gmail_context_contact_insert AFTER INSERT ON contacts BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
  CREATE TRIGGER gmail_context_contact_identity AFTER UPDATE OF email,contact_methods,deleted_at ON contacts
    WHEN NEW.email IS NOT OLD.email OR NEW.contact_methods IS NOT OLD.contact_methods OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
  CREATE TRIGGER gmail_context_contact_delete AFTER DELETE ON contacts BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
  CREATE TRIGGER gmail_context_alias_insert AFTER INSERT ON contact_aliases BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
  CREATE TRIGGER gmail_context_alias_delete AFTER DELETE ON contact_aliases BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
  CREATE TRIGGER gmail_context_alias_update AFTER UPDATE ON contact_aliases BEGIN
    DELETE FROM gmail_person_context; UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL;
  END;
`;
