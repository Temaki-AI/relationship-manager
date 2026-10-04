import type Database from 'better-sqlite3';
import { contactMethodsBackfillSql, contactMethodsTriggersSql } from '../packages/domain/src/contact-method-storage.ts';
import {
  DATABASE_SCHEMA_VERSION,
  DATABASE_SCHEMA_VERSION_KEY,
  REQUIRED_TABLE_COLUMNS,
} from './database-schema.ts';

const DATABASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'local',
    persona TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nickname TEXT,
    email TEXT,
    phone TEXT,
    photo_url TEXT,
    birthday DATE,
    birthday_reminder_days INTEGER NOT NULL DEFAULT 7 CHECK (birthday_reminder_days BETWEEN 0 AND 365),
    how_we_met TEXT,
    tags TEXT,
    notes TEXT,
    gift_ideas TEXT,
    custom_fields TEXT,
    last_contacted DATE,
    contact_frequency INTEGER DEFAULT 14,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contact_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    related_contact_id INTEGER NOT NULL,
    relationship_label TEXT NOT NULL,
    reciprocal_label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (contact_id <> related_contact_id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (related_contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contact_children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    linked_contact_id INTEGER,
    name TEXT NOT NULL,
    birthday DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (linked_contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
    CHECK (linked_contact_id IS NULL OR linked_contact_id <> contact_id)
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    date DATE NOT NULL,
    type TEXT NOT NULL,
    summary TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    remind_at DATETIME NOT NULL,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_snoozes (
    id TEXT PRIMARY KEY,
    contact_id INTEGER NOT NULL,
    reminder_id INTEGER,
    until_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contact_group_members (
    contact_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (contact_id, group_id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS relationship_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence REAL NOT NULL DEFAULT 1,
    last_verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS integration_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    account_email TEXT,
    last_synced_at DATETIME,
    sync_frequency_minutes INTEGER NOT NULL DEFAULT 60,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, provider),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    metadata TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    planned_date DATE NOT NULL,
    summary TEXT,
    notes TEXT,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_plans_contact_id ON plans(contact_id);
  CREATE INDEX IF NOT EXISTS idx_plans_planned_date ON plans(planned_date);
  CREATE INDEX IF NOT EXISTS idx_plans_status_date ON plans(completed_at, planned_date, id);
  CREATE INDEX IF NOT EXISTS idx_plans_contact_date ON plans(contact_id, planned_date, id);
  CREATE INDEX IF NOT EXISTS idx_plans_contact_open_date ON plans(contact_id, completed_at, planned_date, id);
  CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts(last_contacted);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_relationship_pair
    ON contact_relationships(
      CASE WHEN contact_id < related_contact_id THEN contact_id ELSE related_contact_id END,
      CASE WHEN contact_id < related_contact_id THEN related_contact_id ELSE contact_id END
    );
  CREATE INDEX IF NOT EXISTS idx_contact_relationships_contact ON contact_relationships(contact_id, id);
  CREATE INDEX IF NOT EXISTS idx_contact_relationships_related ON contact_relationships(related_contact_id, id);
  CREATE INDEX IF NOT EXISTS idx_contact_children_contact ON contact_children(contact_id, name COLLATE NOCASE, id);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact_date ON interactions(contact_id, date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_reminders_contact_id ON reminders(contact_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_open_due ON reminders(completed_at, remind_at, id);
  CREATE INDEX IF NOT EXISTS idx_reminders_open_due_instant ON reminders(completed_at, julianday(remind_at), id);
  CREATE INDEX IF NOT EXISTS idx_reminders_contact_open_due ON reminders(contact_id, completed_at, julianday(remind_at), id);
  CREATE INDEX IF NOT EXISTS idx_daily_snoozes_until ON daily_snoozes(until_date, id);
  CREATE INDEX IF NOT EXISTS idx_relationship_facts_contact_id ON relationship_facts(contact_id);
  CREATE INDEX IF NOT EXISTS idx_relationship_facts_contact_date ON relationship_facts(contact_id, COALESCE(last_verified_at, created_at) DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_contact_group_members_group ON contact_group_members(group_id, contact_id);
  CREATE INDEX IF NOT EXISTS idx_integration_connections_workspace ON integration_connections(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sync_jobs_workspace_provider ON sync_jobs(workspace_id, provider, started_at DESC);
  CREATE TABLE IF NOT EXISTS contact_source_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, account_key TEXT NOT NULL, external_id TEXT NOT NULL, profile_url TEXT NOT NULL,
    origin TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fields) AND json_type(fields) = 'object' AND length(CAST(fields AS BLOB)) <= 16384),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    observed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, public_id), UNIQUE(workspace_id, provider, account_key, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_source_links_contact ON contact_source_links(contact_id, id);
  CREATE TRIGGER IF NOT EXISTS source_links_limit_insert BEFORE INSERT ON contact_source_links
    WHEN (SELECT COUNT(*) FROM contact_source_links WHERE contact_id = NEW.contact_id) >= 32
    BEGIN SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT'); END;
  CREATE TRIGGER IF NOT EXISTS source_links_limit_update BEFORE UPDATE OF contact_id ON contact_source_links
    WHEN (SELECT COUNT(*) FROM contact_source_links WHERE contact_id = NEW.contact_id AND id != NEW.id) >= 32
    BEGIN SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT'); END;
`;

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = error.code;
  return typeof code === 'string'
    && (code === 'SQLITE_BUSY'
      || code.startsWith('SQLITE_BUSY_')
      || code === 'SQLITE_LOCKED'
      || code.startsWith('SQLITE_LOCKED_'));
}

function wait(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function withDatabaseBusyRetry<T>(operation: () => T): T {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt === 79) throw error;
      wait(Math.min(25 + attempt * 10, 250));
    }
  }
  throw new Error('SQLite initialization retry limit reached.');
}

function getTableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function getStoredSchemaVersion(db: Database.Database): string | null {
  const metadataTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_metadata'
  `).get();
  if (!metadataTable) return null;

  const row = db.prepare('SELECT value FROM app_metadata WHERE key = ?')
    .get(DATABASE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function assertSupportedSchemaVersion(version: string | null) {
  if (!version) return;
  const parsed = Number(version);
  if (!Number.isInteger(parsed) || parsed > Number(DATABASE_SCHEMA_VERSION)) {
    throw new Error(`Database schema version ${version} is newer than this version of Everclose CRM supports.`);
  }
}

function migrateKnownLegacySchemas(db: Database.Database) {
  const contactColumns = getTableColumns(db, 'contacts');
  if (!contactColumns.has('custom_fields')) {
    db.exec('ALTER TABLE contacts ADD COLUMN custom_fields TEXT');
  }
  if (!contactColumns.has('nickname')) {
    db.exec('ALTER TABLE contacts ADD COLUMN nickname TEXT');
  }
  if (!contactColumns.has('birthday_reminder_days')) {
    db.exec(`
      ALTER TABLE contacts
      ADD COLUMN birthday_reminder_days INTEGER NOT NULL DEFAULT 7
      CHECK (birthday_reminder_days BETWEEN 0 AND 365)
    `);
  }
  if (!contactColumns.has('contact_methods')) {
    db.exec("ALTER TABLE contacts ADD COLUMN contact_methods TEXT NOT NULL DEFAULT 'null'");
    db.exec(contactMethodsBackfillSql());
  }
  db.exec(contactMethodsTriggersSql());
  const childColumns = getTableColumns(db, 'contact_children');
  if (!childColumns.has('linked_contact_id')) {
    db.exec(`ALTER TABLE contact_children ADD COLUMN linked_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL
      CHECK (linked_contact_id IS NULL OR linked_contact_id <> contact_id)`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_children_linked
    ON contact_children(contact_id, linked_contact_id) WHERE linked_contact_id IS NOT NULL`);
}

function assertRequiredSchema(db: Database.Database) {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const columns = getTableColumns(db, table);
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`Database schema is missing ${table}.${missing.join(` and ${table}.`)}.`);
    }
  }
}

function hasCurrentSchema(db: Database.Database): boolean {
  if (getStoredSchemaVersion(db) !== DATABASE_SCHEMA_VERSION) return false;
  if (db.pragma('user_version', { simple: true }) !== Number(DATABASE_SCHEMA_VERSION)) return false;

  return Object.entries(REQUIRED_TABLE_COLUMNS).every(([table, requiredColumns]) => {
    const columns = getTableColumns(db, table);
    return requiredColumns.every((column) => columns.has(column));
  });
}

export function initializeDatabase(db: Database.Database) {
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = OFF');
  withDatabaseBusyRetry(() => {
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
      db.pragma('journal_mode = WAL');
    }
  });
  db.pragma('synchronous = NORMAL');

  withDatabaseBusyRetry(() => {
    if (hasCurrentSchema(db)) return;
    const migration = db.transaction(() => {
      if (hasCurrentSchema(db)) return;
      db.exec(DATABASE_SCHEMA_SQL);
      assertSupportedSchemaVersion(getStoredSchemaVersion(db));
      migrateKnownLegacySchemas(db);
      assertRequiredSchema(db);

      db.prepare(`
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(DATABASE_SCHEMA_VERSION_KEY, DATABASE_SCHEMA_VERSION);
      db.pragma(`user_version = ${Number(DATABASE_SCHEMA_VERSION)}`);
    });
    migration.immediate();
  });

  const quickCheck = withDatabaseBusyRetry(
    () => db.pragma('quick_check', { simple: true }) as string
  );
  if (quickCheck !== 'ok') {
    throw new Error(`SQLite quick check failed: ${quickCheck}`);
  }
}
