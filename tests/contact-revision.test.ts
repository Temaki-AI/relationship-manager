import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import {
  getContactEditRevision,
  getExpectedContactRevision,
  updateContactIfCurrent,
} from '../lib/contact-revision.ts';
import type { Contact } from '../lib/db.ts';

function createContactDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const id = Number(db.prepare(`
    INSERT INTO contacts (name, email, tags, notes)
    VALUES ('Ada Lovelace', 'ada@example.test', '["friend"]', 'Original note')
  `).run().lastInsertRowid);
  return { db, id };
}

function loadContact(db: Database.Database, id: number): Contact {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact;
}

test('contact edit revisions cover editable content but ignore the generic update timestamp', () => {
  const { db, id } = createContactDatabase();
  try {
    const original = loadContact(db, id);
    const revision = getContactEditRevision(original);
    db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?')
      .run('2040-01-01T00:00:00.000Z', id);
    assert.equal(getContactEditRevision(loadContact(db, id)), revision);

    db.prepare('UPDATE contacts SET last_contacted = ? WHERE id = ?').run('2026-07-10', id);
    assert.notEqual(getContactEditRevision(loadContact(db, id)), revision);

    const currentRevision = getContactEditRevision(loadContact(db, id));
    db.prepare('UPDATE contacts SET nickname = ? WHERE id = ?').run('Addie', id);
    assert.notEqual(getContactEditRevision(loadContact(db, id)), currentRevision);
  } finally {
    db.close();
  }
});

test('contact updates reject stale revisions without overwriting newer data', () => {
  const { db, id } = createContactDatabase();
  try {
    const initialRevision = getContactEditRevision(loadContact(db, id));
    const first = updateContactIfCurrent(db, id, { notes: 'First editor won' }, initialRevision);
    assert.equal(first.status, 'updated');
    if (first.status !== 'updated') return;

    const stale = updateContactIfCurrent(db, id, { notes: 'Stale editor overwrite' }, initialRevision);
    assert.equal(stale.status, 'conflict');
    assert.equal(loadContact(db, id).notes, 'First editor won');
    assert.notEqual(first.editRevision, initialRevision);
  } finally {
    db.close();
  }
});

test('contact revision requests require a complete fingerprint', () => {
  const valid = 'a'.repeat(64);
  assert.equal(getExpectedContactRevision({ expected_edit_revision: valid.toUpperCase() }), valid);
  assert.throws(() => getExpectedContactRevision({}), /refresh this contact/i);
  assert.throws(() => getExpectedContactRevision({ expected_edit_revision: 'stale' }), /refresh this contact/i);
});
