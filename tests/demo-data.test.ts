import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { initializeDemoData } from '../lib/demo-data.ts';

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      birthday DATE,
      how_we_met TEXT,
      tags TEXT,
      notes TEXT,
      custom_fields TEXT,
      last_contacted DATE,
      contact_frequency INTEGER DEFAULT 14
    );

    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      date DATE NOT NULL,
      type TEXT NOT NULL,
      summary TEXT,
      notes TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      remind_at DATETIME NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE relationship_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 1,
      last_verified_at DATETIME,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
  `);
  return db;
}

test('production databases start empty unless demo data is explicitly enabled', () => {
  const db = createDatabase();

  try {
    assert.equal(initializeDemoData(db, { NODE_ENV: 'production' }), 'skipped');
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count,
      0
    );
  } finally {
    db.close();
  }
});

test('demo data seeds once and does not reappear after contacts are deleted', () => {
  const db = createDatabase();

  try {
    // Exercise databases whose AUTOINCREMENT sequence no longer starts at one.
    db.prepare('INSERT INTO contacts (name) VALUES (?)').run('Deleted setup contact');
    db.prepare('DELETE FROM contacts').run();

    assert.equal(initializeDemoData(db, { NODE_ENV: 'development' }), 'seeded');
    const seededContacts = db.prepare('SELECT id FROM contacts ORDER BY id').all() as Array<{ id: number }>;
    assert.equal(seededContacts.length, 4);
    assert.ok(seededContacts[0].id > 1);
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM interactions').get() as { count: number }).count,
      5
    );

    db.prepare('DELETE FROM contacts').run();

    assert.equal(initializeDemoData(db, { NODE_ENV: 'development' }), 'already-initialized');
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count,
      0
    );
  } finally {
    db.close();
  }
});

test('existing user data is marked so it can never trigger later demo seeding', () => {
  const db = createDatabase();

  try {
    db.prepare('INSERT INTO contacts (name) VALUES (?)').run('Real person');
    assert.equal(
      initializeDemoData(db, { NODE_ENV: 'development' }),
      'recorded-existing-data'
    );

    db.prepare('DELETE FROM contacts').run();
    assert.equal(initializeDemoData(db, { SEED_DEMO_DATA: 'true' }), 'already-initialized');
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count,
      0
    );
  } finally {
    db.close();
  }
});
