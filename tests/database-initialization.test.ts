import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { DATABASE_SCHEMA_VERSION, DATABASE_SCHEMA_VERSION_KEY } from '../lib/database-schema.ts';

test('database initialization migrates the original schema without losing contacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-migration-'));
  const db = new Database(join(root, 'legacy.db'));

  try {
    db.exec(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        photo_url TEXT,
        birthday DATE,
        how_we_met TEXT,
        tags TEXT,
        notes TEXT,
        gift_ideas TEXT,
        last_contacted DATE,
        contact_frequency INTEGER DEFAULT 14,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL,
        date DATE NOT NULL,
        type TEXT NOT NULL,
        summary TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );
      INSERT INTO contacts (name, email) VALUES ('Legacy contact', 'legacy@example.test');
      CREATE TABLE contact_children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        birthday DATE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO contact_children (contact_id, name, birthday) VALUES (1, 'Legacy child', '2020-01-01');
    `);

    initializeDatabase(db);

    const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'custom_fields'));
    assert.ok(columns.some((column) => column.name === 'nickname'));
    assert.ok(columns.some((column) => column.name === 'birthday_reminder_days'));
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((table) => table.name)
    );
    assert.ok(tables.has('contact_relationships'));
    assert.ok(tables.has('contact_children'));
    assert.ok((db.pragma('table_info(contact_children)') as Array<{ name: string }>).some((column) => column.name === 'linked_contact_id'));
    assert.equal((db.prepare('SELECT name FROM contact_children WHERE contact_id = 1').get() as { name: string }).name, 'Legacy child');
    assert.equal(
      (db.prepare('SELECT name FROM contacts WHERE id = 1').get() as { name: string }).name,
      'Legacy contact'
    );
    assert.equal(
      (db.prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get(DATABASE_SCHEMA_VERSION_KEY) as { value: string }).value,
      DATABASE_SCHEMA_VERSION
    );
    assert.equal(db.pragma('user_version', { simple: true }), Number(DATABASE_SCHEMA_VERSION));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('database initialization configures resilient SQLite connection settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-pragmas-'));
  const db = new Database(join(root, 'active.db'));

  try {
    initializeDatabase(db);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 10_000);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('trusted_schema', { simple: true }), 0);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    const indexes = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
        .map((index) => index.name)
    );
    assert.ok(indexes.has('idx_interactions_contact_date'));
    assert.ok(indexes.has('idx_reminders_open_due'));
    assert.ok(indexes.has('idx_reminders_open_due_instant'));
    assert.ok(indexes.has('idx_reminders_contact_open_due'));
    assert.ok(indexes.has('idx_plans_contact_open_date'));
    assert.ok(indexes.has('idx_plans_status_date'));
    assert.ok(indexes.has('idx_plans_contact_date'));
    assert.ok(indexes.has('idx_relationship_facts_contact_date'));
    assert.ok(indexes.has('idx_contact_group_members_group'));
    assert.ok(indexes.has('idx_contact_relationship_pair'));
    assert.ok(indexes.has('idx_contact_children_contact'));
    assert.ok(indexes.has('idx_contact_children_linked'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('database initialization refuses a schema created by a newer app version', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-future-schema-'));
  const db = new Database(join(root, 'future.db'));

  try {
    db.exec(`
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME);
      INSERT INTO app_metadata (key, value) VALUES ('${DATABASE_SCHEMA_VERSION_KEY}', '999');
    `);
    assert.throws(() => initializeDatabase(db), /newer than this version/i);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('database initialization safely serializes concurrent processes on a fresh file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-concurrent-schema-'));
  const databasePath = join(root, 'shared.db');
  const childScript = `
    import Database from 'better-sqlite3';
    import { initializeDatabase } from './lib/database-initialization.ts';
    const db = new Database(process.argv[1]);
    try { initializeDatabase(db); } finally { db.close(); }
  `;

  try {
    await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        databasePath,
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `Initializer exited with code ${code}`));
      });
    })));

    const db = new Database(databasePath, { readonly: true });
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.pragma('user_version', { simple: true }), Number(DATABASE_SCHEMA_VERSION));
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('complete database startup is idempotent across concurrent app workers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-concurrent-startup-'));
  const databasePath = join(root, 'shared.db');
  const childScript = `
    const { default: db } = await import('./lib/db.ts');
    db.close();
  `;

  try {
    await Promise.all(Array.from({ length: 12 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          CRM_DATABASE_PATH: databasePath,
          CRM_BACKUP_DIRECTORY: join(root, 'backups'),
          CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS: '0',
          CRM_LOG_LEVEL: 'silent',
          SEED_DEMO_DATA: 'true',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `App worker exited with code ${code}`));
      });
    })));

    const db = new Database(databasePath, { readonly: true });
    try {
      const count = (table: string) => (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      ).count;
      assert.equal(count('workspaces'), 1);
      assert.equal(count('integration_connections'), 0);
      assert.equal(count('sync_jobs'), 0);
      assert.equal(count('contacts'), 4);
      assert.deepEqual(
        db.prepare('SELECT name, plan, persona FROM workspaces').get(),
        { name: 'My Everclose CRM', plan: 'local', persona: 'private-first' }
      );
      assert.equal(
        (db.prepare('SELECT value FROM app_metadata WHERE key = ?')
          .get('demo-data-v1') as { value: string }).value,
        'seeded'
      );
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
