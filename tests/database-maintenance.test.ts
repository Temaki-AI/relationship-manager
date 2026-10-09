import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createDatabaseBackup,
  listDatabaseBackups,
  resolveBackupPath,
  restoreDatabaseBackup,
  validateDatabaseFile,
  verifyDatabaseBackupChecksum,
} from '../lib/database-maintenance.ts';
import { DATABASE_SCHEMA_VERSION, DATABASE_SCHEMA_VERSION_KEY } from '../lib/database-schema.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { contactSourceWriteEpoch } from '../lib/contact-source-storage.ts';

function createDatabase(filename: string) {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  initializeDatabase(db);
  db.prepare('INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)')
    .run(DATABASE_SCHEMA_VERSION_KEY, DATABASE_SCHEMA_VERSION);
  db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(1, 'Test workspace');
  return db;
}

test('backup and restore round-trip data with a pre-restore safety snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-maintenance-'));
  const backupDirectory = join(root, 'backups');
  const activePath = join(root, 'active.db');
  const db = createDatabase(activePath);

  try {
    db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run(1, 'Original contact');
    const sourceEpoch = contactSourceWriteEpoch(db);
    const backup = createDatabaseBackup(db, {
      backupDirectory,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    assert.equal(backup.rowCounts.contacts, 1);
    assert.equal(backup.sha256.length, 64);
    const backupPath = resolveBackupPath(backupDirectory, backup.filename);
    assert.ok(existsSync(backupPath));
    assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(`${backupPath}.json`).mode & 0o777, 0o600);
    assert.equal(listDatabaseBackups(backupDirectory).length, 1);

    db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run('Mutated contact', 1);
    const restored = restoreDatabaseBackup(
      db,
      resolveBackupPath(backupDirectory, backup.filename),
      {
        backupDirectory,
        now: new Date('2026-07-10T12:05:00.000Z'),
      }
    );

    assert.equal(
      (db.prepare('SELECT name FROM contacts WHERE id = 1').get() as { name: string }).name,
      'Original contact'
    );
    assert.equal(restored.restoredRowCounts.contacts, 1);
    assert.notEqual(contactSourceWriteEpoch(db), sourceEpoch, 'Restore invalidates previously opened source forms.');

    const preRestore = new Database(
      resolveBackupPath(backupDirectory, restored.preRestoreBackup.filename),
      { readonly: true }
    );
    try {
      assert.equal(
        (preRestore.prepare('SELECT name FROM contacts WHERE id = 1').get() as { name: string }).name,
        'Mutated contact'
      );
    } finally {
      preRestore.close();
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup retention keeps the newest configured snapshots for one reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-retention-'));
  const backupDirectory = join(root, 'backups');
  const db = createDatabase(join(root, 'active.db'));

  try {
    for (const timestamp of [
      '2026-07-10T10:00:00.000Z',
      '2026-07-10T11:00:00.000Z',
      '2026-07-10T12:00:00.000Z',
    ]) {
      createDatabaseBackup(db, {
        backupDirectory,
        now: new Date(timestamp),
        retentionCount: 2,
      });
    }

    const backups = listDatabaseBackups(backupDirectory);
    assert.equal(backups.length, 2);
    assert.equal(backups[0].createdAt, '2026-07-10T12:00:00.000Z');
    assert.equal(backups[1].createdAt, '2026-07-10T11:00:00.000Z');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup retention preserves the newest checkpoint for every recovery reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-reason-retention-'));
  const backupDirectory = join(root, 'backups');
  const db = createDatabase(join(root, 'active.db'));

  try {
    const reasons = ['manual', 'automatic', 'pre-restore', 'pre-merge'] as const;
    for (const [index, reason] of reasons.entries()) {
      createDatabaseBackup(db, {
        backupDirectory,
        reason,
        now: new Date(`2026-07-10T0${index + 1}:00:00.000Z`),
        retentionCount: 5,
      });
    }
    for (let hour = 5; hour <= 9; hour++) {
      createDatabaseBackup(db, {
        backupDirectory,
        reason: 'pre-delete',
        now: new Date(`2026-07-10T0${hour}:00:00.000Z`),
        retentionCount: 5,
      });
    }

    const backups = listDatabaseBackups(backupDirectory);
    assert.equal(backups.length, 5);
    assert.deepEqual(
      new Set(backups.map((backup) => backup.reason)),
      new Set(['manual', 'automatic', 'pre-restore', 'pre-merge', 'pre-delete'])
    );
    assert.equal(
      backups.find((backup) => backup.reason === 'pre-delete')?.createdAt,
      '2026-07-10T09:00:00.000Z'
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('incompatible backups are rejected before active data changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-invalid-'));
  const active = createDatabase(join(root, 'active.db'));
  const incompatiblePath = join(root, 'incompatible.db');
  const incompatible = createDatabase(incompatiblePath);

  try {
    active.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run(1, 'Keep me');
    incompatible.exec('ALTER TABLE contacts ADD COLUMN unexpected TEXT');
    incompatible.close();

    assert.throws(
      () => validateDatabaseFile(active, incompatiblePath),
      /schema does not match/i
    );
    assert.equal(
      (active.prepare('SELECT name FROM contacts WHERE id = 1').get() as { name: string }).name,
      'Keep me'
    );
  } finally {
    if (incompatible.open) incompatible.close();
    active.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup path resolution rejects traversal', () => {
  assert.throws(() => resolveBackupPath('/tmp/backups', '../relationships.db'), /invalid/i);
  assert.throws(() => resolveBackupPath('/tmp/backups', 'not-a-bonds-backup.db'), /invalid/i);
});

test('backup checksums detect file tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-checksum-'));
  const backupDirectory = join(root, 'backups');
  const db = createDatabase(join(root, 'active.db'));

  try {
    const backup = createDatabaseBackup(db, { backupDirectory });
    const backupPath = resolveBackupPath(backupDirectory, backup.filename);
    verifyDatabaseBackupChecksum(backupPath, backup.sha256);
    assert.throws(() => verifyDatabaseBackupChecksum(backupPath, '0'.repeat(64)), /checksum/i);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
