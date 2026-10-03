export const MOBILE_DATABASE_NAME = 'bonds-mobile.db';
export const MOBILE_SCHEMA_VERSION = 1;

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
