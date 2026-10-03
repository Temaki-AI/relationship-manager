import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  loadIntelligenceOverviewData,
  loadSmartListData,
} from '../lib/intelligence-directory.ts';

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL,
      persona TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      photo_url TEXT,
      birthday TEXT,
      birthday_reminder_days INTEGER NOT NULL DEFAULT 7,
      tags TEXT,
      notes TEXT,
      custom_fields TEXT,
      last_contacted TEXT,
      contact_frequency INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE daily_snoozes (
      id TEXT PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      reminder_id INTEGER,
      until_date TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO workspaces (id, name, plan, persona, created_at)
    VALUES (1, 'Scale Workspace', 'local', NULL, '2026-01-01')
  `).run();

  const insertContact = db.prepare(`
    INSERT INTO contacts (
      id, name, photo_url, birthday, tags, notes, custom_fields,
      last_contacted, contact_frequency, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 14, '2026-01-01', ?)
  `);
  insertContact.run(1, 'Ada', 'data:image/png;base64,private', '["friend"]', 'Private note', '2026-06-01', '2026-07-01');
  insertContact.run(2, 'Grace', null, '["work"]', 'Another private note', '2026-06-02', '2026-07-02');

  const insertInteraction = db.prepare(`
    INSERT INTO interactions (id, contact_id, date, type, summary)
    VALUES (?, ?, ?, 'message', ?)
  `);
  insertInteraction.run(1, 1, '2026-06-01', 'First');
  insertInteraction.run(2, 1, '2026-07-01', 'Latest lower ID');
  insertInteraction.run(3, 1, '2026-07-01', 'Latest tie winner');
  insertInteraction.run(4, 2, '2026-06-15', 'Grace latest');

  const insertReminder = db.prepare(`
    INSERT INTO reminders (id, contact_id, title, remind_at, completed_at)
    VALUES (?, 1, ?, ?, ?)
  `);
  for (let id = 1; id <= 5; id += 1) {
    insertReminder.run(id, `Reminder ${id}`, `2026-07-${String(id).padStart(2, '0')}`, null);
  }
  insertReminder.run(6, 'Completed', '2026-06-01', '2026-06-02');
  return db;
}

test('intelligence directory returns minimal contacts and one activity row per contact', () => {
  const db = createDatabase();
  try {
    const { contacts, activity } = loadSmartListData(db, '2026-07-01');

    assert.equal(contacts.length, 2);
    assert.equal('notes' in contacts[0], false);
    assert.equal('photo_url' in contacts[0], false);
    assert.equal(activity.size, 2);
    assert.equal(activity.get(1)?.interactionsCount, 3);
    assert.equal(activity.get(1)?.latestInteraction?.id, 3);
    assert.equal(activity.get(1)?.latestInteraction?.summary, 'Latest tie winner');
    assert.deepEqual(activity.get(1)?.openReminders, []);
  } finally {
    db.close();
  }
});

test('intelligence overview bounds feed reminders while preserving the full count', () => {
  const db = createDatabase();
  try {
    const data = loadIntelligenceOverviewData(db, '2026-07-01');

    assert.equal(data.workspace?.name, 'Scale Workspace');
    assert.equal(data.openReminderCount, 5);
    assert.deepEqual(data.feedReminders.map((reminder) => reminder.id), [1]);
    assert.equal('notes' in data.feedReminders[0], false);
  } finally {
    db.close();
  }
});

test('intelligence directory fills reminder slots after active snoozes', () => {
  const db = createDatabase();
  try {
    const insert = db.prepare('INSERT INTO daily_snoozes (id, contact_id, reminder_id, until_date) VALUES (?, 1, ?, ?)');
    for (let id = 1; id <= 4; id += 1) insert.run(`reminder-${id}`, id, '2026-07-08');
    const data = loadIntelligenceOverviewData(db, '2026-07-01');
    assert.deepEqual(data.feedReminders.map((reminder) => reminder.id), [5]);
    assert.equal(data.openReminderCount, 5);
  } finally {
    db.close();
  }
});

test('intelligence directory selects distinct people before limiting the Today queue', () => {
  const db = createDatabase();
  try {
    db.prepare("INSERT INTO reminders (id, contact_id, title, remind_at) VALUES (7, 2, 'Check on Grace', '2026-07-07')").run();
    const data = loadIntelligenceOverviewData(db, '2026-07-08');
    assert.deepEqual(data.feedReminders.map((reminder) => reminder.id), [1, 7]);
    assert.equal(data.openReminderCount, 6);
  } finally {
    db.close();
  }
});
