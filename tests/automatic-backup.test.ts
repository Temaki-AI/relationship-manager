import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureAutomaticDatabaseBackup,
  getAutomaticBackupStatus,
} from '../lib/automatic-backup.ts';
import { getDatabaseMaintenanceLockPath } from '../lib/database-maintenance-lock.ts';
import { getAutomaticBackupIntervalHours } from '../lib/database-maintenance-config.ts';
import { listDatabaseBackups } from '../lib/database-maintenance.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDatabase(filename: string) {
  const db = new Database(filename);
  initializeDatabase(db);
  return db;
}

test('automatic backup configuration defaults safely and accepts bounded overrides', () => {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousInterval = process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
  try {
    delete process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
    process.env.NODE_ENV = 'development';
    assert.equal(getAutomaticBackupIntervalHours(), 0);
    process.env.NODE_ENV = 'production';
    assert.equal(getAutomaticBackupIntervalHours(), 24);
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '12';
    assert.equal(getAutomaticBackupIntervalHours(), 12);
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '0';
    assert.equal(getAutomaticBackupIntervalHours(), 0);
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '99999';
    assert.equal(getAutomaticBackupIntervalHours(), 8_760);
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = 'invalid';
    assert.equal(getAutomaticBackupIntervalHours(), 24);
  } finally {
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    if (previousInterval === undefined) delete process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
    else process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = previousInterval;
  }
});

test('automatic backups run only when due and participate in retention', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-automatic-backup-'));
  const backupDirectory = join(root, 'backups');
  const db = createDatabase(join(root, 'active.db'));
  try {
    db.prepare('INSERT INTO contacts (name) VALUES (?)').run('Protected contact');
    const firstTime = new Date('2026-07-11T08:00:00.000Z');
    assert.equal(
      getAutomaticBackupStatus(backupDirectory, { now: firstTime, intervalHours: 24 }).state,
      'due'
    );
    const first = ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now: firstTime,
      intervalHours: 24,
      retentionCount: 2,
    });
    assert.equal(first.state, 'current');
    assert.equal(first.latestBackupAt, firstTime.toISOString());
    assert.equal(first.nextBackupAt, '2026-07-12T08:00:00.000Z');
    assert.equal(listDatabaseBackups(backupDirectory).length, 1);
    assert.equal(listDatabaseBackups(backupDirectory)[0].reason, 'automatic');

    ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now: new Date('2026-07-11T20:00:00.000Z'),
      intervalHours: 24,
      retentionCount: 2,
    });
    assert.equal(listDatabaseBackups(backupDirectory).length, 1);

    ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now: new Date('2026-07-12T09:00:00.000Z'),
      intervalHours: 24,
      retentionCount: 2,
    });
    ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now: new Date('2026-07-13T10:00:00.000Z'),
      intervalHours: 24,
      retentionCount: 2,
    });
    const retained = listDatabaseBackups(backupDirectory);
    assert.equal(retained.length, 2);
    assert.deepEqual(retained.map((backup) => backup.createdAt), [
      '2026-07-13T10:00:00.000Z',
      '2026-07-12T09:00:00.000Z',
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic backup locking preserves active locks and recovers stale locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-automatic-lock-'));
  const backupDirectory = join(root, 'backups');
  const lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  const db = createDatabase(join(root, 'active.db'));
  try {
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(lockPath, 'active');
    const now = new Date('2026-07-11T08:00:00.000Z');
    utimesSync(lockPath, now, now);
    const locked = ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now,
      intervalHours: 24,
    });
    assert.equal(locked.state, 'due');
    assert.equal(existsSync(lockPath), true);
    assert.equal(listDatabaseBackups(backupDirectory).length, 0);

    const stale = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    utimesSync(lockPath, stale, stale);
    const recovered = ensureAutomaticDatabaseBackup(db, backupDirectory, {
      now,
      intervalHours: 24,
    });
    assert.equal(recovered.state, 'current');
    assert.equal(existsSync(lockPath), false);
    assert.equal(listDatabaseBackups(backupDirectory).length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic backup failures are reported without preventing database access', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-automatic-failure-'));
  const invalidBackupDirectory = join(root, 'not-a-directory');
  const db = createDatabase(join(root, 'active.db'));
  try {
    writeFileSync(invalidBackupDirectory, 'blocked');
    const status = ensureAutomaticDatabaseBackup(db, invalidBackupDirectory, {
      now: new Date('2026-07-11T08:00:00.000Z'),
      intervalHours: 24,
    });
    assert.equal(status.state, 'failed');
    assert.equal(
      (db.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count,
      0
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repeated backup status failures are log-rate-limited per directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-automatic-log-limit-'));
  const invalidBackupDirectory = join(root, 'not-a-directory');
  const originalConsoleError = console.error;
  const logs: string[] = [];
  try {
    writeFileSync(invalidBackupDirectory, 'blocked');
    console.error = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
    const first = new Date('2026-07-11T08:00:00.000Z');

    getAutomaticBackupStatus(invalidBackupDirectory, { now: first, intervalHours: 24 });
    getAutomaticBackupStatus(invalidBackupDirectory, {
      now: new Date(first.getTime() + 1_000),
      intervalHours: 24,
    });
    assert.equal(logs.filter((line) => line.includes('backup.status_failed')).length, 1);

    getAutomaticBackupStatus(invalidBackupDirectory, {
      now: new Date(first.getTime() + 5 * 60 * 1000),
      intervalHours: 24,
    });
    assert.equal(logs.filter((line) => line.includes('backup.status_failed')).length, 2);
  } finally {
    console.error = originalConsoleError;
    rmSync(root, { recursive: true, force: true });
  }
});
