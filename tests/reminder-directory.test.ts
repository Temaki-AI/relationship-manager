import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  listBirthdayNotificationCandidates,
  listNotificationCandidates,
  listReminderPage,
  MAX_NOTIFICATION_CANDIDATES,
} from '../lib/reminder-directory.ts';

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      birthday TEXT,
      birthday_reminder_days INTEGER NOT NULL DEFAULT 7
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      remind_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX idx_reminders_open_due ON reminders(completed_at, remind_at, id);
    INSERT INTO contacts (id, name) VALUES (1, 'Scale Contact');
  `);
  return db;
}

test('reminder directory returns stable bounded pages and accurate totals', () => {
  const db = createDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO reminders (id, contact_id, title, notes, remind_at, completed_at)
      VALUES (?, 1, ?, ?, ?, NULL)
    `);
    for (let id = 1; id <= 137; id += 1) {
      insert.run(
        id,
        `Reminder ${id}`,
        `Private note ${id}`,
        new Date(Date.UTC(2026, 6, 1, 0, 0, id)).toISOString()
      );
    }

    const first = listReminderPage(db);
    assert.equal(first.reminders.length, 50);
    assert.deepEqual(first.pagination, {
      page: 1,
      pageSize: 50,
      total: 137,
      totalPages: 3,
    });
    assert.deepEqual(
      Object.keys(first.reminders[0]).sort(),
      ['contact_id', 'contact_name', 'id', 'notes', 'remind_at', 'title']
    );

    const last = listReminderPage(db, { page: 99, pageSize: 50 });
    assert.equal(last.pagination.page, 3);
    assert.equal(last.reminders.length, 37);
    assert.equal(last.reminders[0].id, 101);

    const clamped = listReminderPage(db, { pageSize: 5_000 });
    assert.equal(clamped.pagination.pageSize, 100);
    assert.equal(clamped.reminders.length, 100);
  } finally {
    db.close();
  }
});

test('notification candidates are due-only, minimal, newest-first, and ledger-bounded', () => {
  const db = createDatabase();
  try {
    const now = new Date('2026-07-11T12:00:00.000Z');
    const insert = db.prepare(`
      INSERT INTO reminders (id, contact_id, title, notes, remind_at, completed_at)
      VALUES (?, 1, ?, ?, ?, ?)
    `);
    for (let id = 1; id <= MAX_NOTIFICATION_CANDIDATES + 105; id += 1) {
      insert.run(
        id,
        `Due ${id}`,
        `Private note ${id}`,
        new Date(now.getTime() - id * 1_000).toISOString(),
        null
      );
    }
    insert.run(3_000, 'Completed', 'Private', '2026-07-11T10:00:00.000Z', '2026-07-11T11:00:00.000Z');
    insert.run(3_001, 'Future', 'Private', '2026-07-12T10:00:00.000Z', null);

    const candidates = listNotificationCandidates(db, now);
    assert.equal(candidates.length, MAX_NOTIFICATION_CANDIDATES);
    assert.equal(candidates[0].id, 1);
    assert.equal(candidates.at(-1)?.id, MAX_NOTIFICATION_CANDIDATES);
    assert.deepEqual(Object.keys(candidates[0]).sort(), ['id', 'remind_at']);
    assert.equal(candidates.some((candidate) => candidate.id === 3_000), false);
    assert.equal(candidates.some((candidate) => candidate.id === 3_001), false);
  } finally {
    db.close();
  }
});

test('birthday notification candidates honor each contact lead time and annual occurrence', () => {
  const db = createDatabase();
  try {
    db.prepare(`
      INSERT INTO contacts (id, name, birthday, birthday_reminder_days)
      VALUES (?, ?, ?, ?)
    `).run(2, 'Seven Day Alert', '1990-07-18', 7);
    db.prepare(`
      INSERT INTO contacts (id, name, birthday, birthday_reminder_days)
      VALUES (?, ?, ?, ?)
    `).run(3, 'Not Due Yet', '1990-07-19', 7);
    db.prepare(`
      INSERT INTO contacts (id, name, birthday, birthday_reminder_days)
      VALUES (?, ?, ?, ?)
    `).run(4, 'Same Day Alert', '1990-07-11', 0);

    assert.deepEqual(
      listBirthdayNotificationCandidates(db, new Date('2026-07-11T12:00:00.000Z')),
      [
        { id: 2, occurrence: '2026-07-18' },
        { id: 4, occurrence: '2026-07-11' },
      ]
    );
  } finally {
    db.close();
  }
});

test('reminder queries compare offset timestamps by instant instead of text order', () => {
  const db = createDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO reminders (id, contact_id, title, notes, remind_at, completed_at)
      VALUES (?, 1, ?, NULL, ?, NULL)
    `);
    insert.run(1, 'Ten UTC', '2026-07-11T10:00:00Z');
    insert.run(2, 'Ten thirty UTC', '2026-07-11T09:30:00-01:00');
    insert.run(3, 'Twelve UTC', '2026-07-11T14:00:00+02:00');
    insert.run(4, 'Twelve thirty UTC', '2026-07-11T08:30:00-04:00');

    const page = listReminderPage(db);
    assert.deepEqual(page.reminders.map((reminder) => reminder.id), [1, 2, 3, 4]);

    const due = listNotificationCandidates(db, new Date('2026-07-11T12:00:00.000Z'));
    assert.deepEqual(due.map((reminder) => reminder.id), [3, 2, 1]);
  } finally {
    db.close();
  }
});
