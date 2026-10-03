import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ContactDeletionError,
  deleteContactsWithRecovery,
  MAX_CONTACT_DELETE_BATCH_SIZE,
} from '../lib/contact-deletion.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { listDatabaseBackups, resolveBackupPath } from '../lib/database-maintenance.ts';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bonds-contact-delete-'));
  const db = new Database(join(root, 'active.db'));
  initializeDatabase(db);
  return { root, db, backupDirectory: join(root, 'backups') };
}

function insertContact(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO contacts (name) VALUES (?)').run(name).lastInsertRowid);
}

test('contact deletion saves a verified recovery point before cascading relationship history', () => {
  const fixture = createFixture();
  try {
    const firstId = insertContact(fixture.db, 'Ada Lovelace');
    const secondId = insertContact(fixture.db, 'Grace Hopper');
    const groupId = Number(fixture.db.prepare('INSERT INTO contact_groups (name) VALUES (?)')
      .run('Pioneers').lastInsertRowid);
    fixture.db.prepare(
      'INSERT INTO interactions (contact_id, date, type, summary) VALUES (?, ?, ?, ?)'
    ).run(firstId, '2026-07-01', 'meeting', 'Coffee');
    fixture.db.prepare(
      'INSERT INTO reminders (contact_id, title, remind_at) VALUES (?, ?, ?)'
    ).run(firstId, 'Follow up', '2026-08-01T10:00:00.000Z');
    fixture.db.prepare(
      'INSERT INTO relationship_facts (contact_id, category, label, value) VALUES (?, ?, ?, ?)'
    ).run(firstId, 'personal', 'Favorite drink', 'Tea');
    fixture.db.prepare(
      'INSERT INTO plans (contact_id, type, planned_date, summary) VALUES (?, ?, ?, ?)'
    ).run(firstId, 'meeting', '2026-08-02', 'Lunch');
    fixture.db.prepare(
      'INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
    ).run(firstId, groupId);

    const result = deleteContactsWithRecovery(
      fixture.db,
      fixture.backupDirectory,
      [firstId, secondId],
      { now: new Date('2026-07-11T12:00:00.000Z') }
    );

    assert.equal(result.affected, 2);
    assert.equal(result.recoveryPoint.reason, 'pre-delete');
    assert.equal(result.recoveryPoint.rowCounts.contacts, 2);
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM contacts').get() as { count: number }).count, 0);
    for (const table of ['interactions', 'reminders', 'relationship_facts', 'plans', 'contact_group_members']) {
      assert.equal(
        (fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0
      );
    }

    const snapshot = new Database(
      resolveBackupPath(fixture.backupDirectory, result.recoveryPoint.filename),
      { readonly: true }
    );
    try {
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM contacts').get() as { count: number }).count, 2);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM interactions').get() as { count: number }).count, 1);
    } finally {
      snapshot.close();
    }
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stale bulk selection fails without deleting contacts or creating a recovery point', () => {
  const fixture = createFixture();
  try {
    const contactId = insertContact(fixture.db, 'Existing contact');
    assert.throws(
      () => deleteContactsWithRecovery(fixture.db, fixture.backupDirectory, [contactId, 999_999]),
      (error: unknown) => error instanceof ContactDeletionError && error.code === 'not_found'
    );
    assert.ok(fixture.db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId));
    assert.deepEqual(listDatabaseBackups(fixture.backupDirectory), []);
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deletion fails closed when a verified recovery point cannot be written', () => {
  const fixture = createFixture();
  try {
    const contactId = insertContact(fixture.db, 'Protected contact');
    const blockedPath = join(fixture.root, 'not-a-directory');
    writeFileSync(blockedPath, 'blocked');

    assert.throws(() => deleteContactsWithRecovery(
      fixture.db,
      join(blockedPath, 'backups'),
      [contactId]
    ));
    assert.ok(fixture.db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId));
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('contact deletion rejects oversized batches before database maintenance begins', () => {
  const fixture = createFixture();
  try {
    const ids = Array.from({ length: MAX_CONTACT_DELETE_BATCH_SIZE + 1 }, (_, index) => index + 1);
    assert.throws(
      () => deleteContactsWithRecovery(fixture.db, fixture.backupDirectory, ids),
      (error: unknown) => error instanceof ContactDeletionError && error.code === 'invalid_input'
    );
    assert.deepEqual(listDatabaseBackups(fixture.backupDirectory), []);
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
