import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  completeReminderRecord,
  completePlanRecord,
  createInteractionRecord,
  deleteInteractionRecord,
} from '../lib/relationship-mutations.ts';
import {
  getExpectedInteractionRevision,
  getInteractionEditRevision,
  updateInteractionIfCurrent,
} from '../lib/interaction-revision.ts';
import type { Interaction } from '../lib/db.ts';

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      last_contacted DATE,
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
    CREATE TABLE plans (
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
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      remind_at DATETIME NOT NULL,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    INSERT INTO contacts (id, name) VALUES (1, 'Ada');
  `);
  return db;
}

test('interaction edits require a complete loaded revision', () => {
  const valid = 'b'.repeat(64);
  assert.equal(
    getExpectedInteractionRevision({ expected_edit_revision: valid.toUpperCase() }),
    valid
  );
  assert.throws(() => getExpectedInteractionRevision({}), /refresh this interaction/i);
  assert.throws(
    () => getExpectedInteractionRevision({ expected_edit_revision: 'stale' }),
    /refresh this interaction/i
  );
});

test('reminder completion is write-once and preserves the original timestamp', () => {
  const db = createDatabase();
  try {
    const reminderId = Number(db.prepare(`
      INSERT INTO reminders (contact_id, title, remind_at)
      VALUES (1, 'Follow up', '2026-07-12T09:00:00.000Z')
    `).run().lastInsertRowid);
    const firstTimestamp = '2026-07-11T12:30:00.000Z';
    const laterTimestamp = '2026-07-11T13:30:00.000Z';

    const first = completeReminderRecord(db, reminderId, firstTimestamp);
    const replay = completeReminderRecord(db, reminderId, laterTimestamp);
    assert.equal(first.status, 'completed');
    assert.equal(replay.status, 'already-completed');
    assert.equal(first.reminder?.completed_at, firstTimestamp);
    assert.equal(replay.reminder?.completed_at, firstTimestamp);
    assert.equal(completeReminderRecord(db, 999_999, laterTimestamp).status, 'not-found');
  } finally {
    db.close();
  }
});

test('interaction mutations keep last_contacted consistent', () => {
  const db = createDatabase();
  try {
    const first = createInteractionRecord(db, {
      contactId: 1,
      date: '2026-07-01',
      type: 'call',
      summary: null,
      notes: null,
    });
    const second = createInteractionRecord(db, {
      contactId: 1,
      date: '2026-07-10',
      type: 'email',
      summary: 'Follow-up',
      notes: null,
    });
    assert.equal(
      (db.prepare('SELECT last_contacted FROM contacts WHERE id = 1').get() as { last_contacted: string }).last_contacted,
      '2026-07-10'
    );

    const secondRevision = getInteractionEditRevision(
      db.prepare('SELECT * FROM interactions WHERE id = ?').get(second.id) as Interaction
    );
    const updated = updateInteractionIfCurrent(db, second.id, {
      date: '2026-06-20',
      type: 'email',
      summary: null,
      notes: null,
    }, secondRevision);
    assert.equal(updated.status, 'updated');
    assert.equal(
      (db.prepare('SELECT last_contacted FROM contacts WHERE id = 1').get() as { last_contacted: string }).last_contacted,
      '2026-07-01'
    );

    const stale = updateInteractionIfCurrent(db, second.id, {
      date: '2026-12-31',
      type: 'message',
      summary: 'Stale overwrite',
      notes: null,
    }, secondRevision);
    assert.equal(stale.status, 'conflict');
    assert.equal(
      (db.prepare('SELECT date FROM interactions WHERE id = ?').get(second.id) as { date: string }).date,
      '2026-06-20'
    );

    assert.equal(deleteInteractionRecord(db, first.id), true);
    assert.equal(
      (db.prepare('SELECT last_contacted FROM contacts WHERE id = 1').get() as { last_contacted: string }).last_contacted,
      '2026-06-20'
    );
  } finally {
    db.close();
  }
});

test('plan completion is transactional and idempotent', () => {
  const db = createDatabase();
  try {
    const result = db.prepare(`
      INSERT INTO plans (contact_id, type, planned_date, summary)
      VALUES (1, 'call', '2026-07-08', 'Catch up')
    `).run();
    const planId = Number(result.lastInsertRowid);
    const completedAt = '2026-07-10T12:30:00.000Z';

    assert.equal(completePlanRecord(db, planId, completedAt).status, 'completed');
    assert.equal(completePlanRecord(db, planId, completedAt).status, 'already-completed');
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM interactions').get() as { count: number }).count,
      1
    );
    assert.equal(
      (db.prepare('SELECT date FROM interactions').get() as { date: string }).date,
      '2026-07-10'
    );
  } finally {
    db.close();
  }
});

test('plan completion rolls back when interaction logging fails', () => {
  const db = createDatabase();
  try {
    const result = db.prepare(`
      INSERT INTO plans (contact_id, type, planned_date) VALUES (1, 'call', '2026-07-10')
    `).run();
    const planId = Number(result.lastInsertRowid);
    db.exec(`
      CREATE TRIGGER reject_interaction BEFORE INSERT ON interactions
      BEGIN SELECT RAISE(ABORT, 'interaction rejected'); END;
    `);

    assert.throws(
      () => completePlanRecord(db, planId, '2026-07-10T12:30:00.000Z'),
      /interaction rejected/i
    );
    assert.equal(
      (db.prepare('SELECT completed_at FROM plans WHERE id = ?').get(planId) as { completed_at: string | null }).completed_at,
      null
    );
  } finally {
    db.close();
  }
});
