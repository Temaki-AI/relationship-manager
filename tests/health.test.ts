import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { createDatabaseBackup } from '../lib/database-maintenance.ts';
import { getReadinessReport } from '../lib/health.ts';

const enabledAuth = {
  mode: 'enabled' as const,
  password: 'health-test-password',
  sessionSecret: 'health-test-session-secret-123456789',
  sessionTtlSeconds: 3600,
  apiToken: null,
};

test('readiness is passive and reports a due backup as degraded', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-health-passive-'));
  const backupDirectory = join(root, 'backups');
  const db = new Database(join(root, 'active.db'));
  const previousInterval = process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
  try {
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '24';
    initializeDatabase(db);

    const first = getReadinessReport(db, backupDirectory, enabledAuth);
    const second = getReadinessReport(db, backupDirectory, enabledAuth);
    assert.deepEqual(first, second);
    assert.equal(first.status, 'degraded');
    assert.equal(first.ready, true);
    assert.equal(first.checks.backup, 'due');
    assert.equal(existsSync(backupDirectory), false);
  } finally {
    if (previousInterval === undefined) delete process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
    else process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = previousInterval;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('readiness distinguishes current, disabled, and failed backup protection', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-health-backup-'));
  const backupDirectory = join(root, 'backups');
  const invalidBackupDirectory = join(root, 'not-a-directory');
  const db = new Database(join(root, 'active.db'));
  const previousInterval = process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
  try {
    initializeDatabase(db);
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '24';
    createDatabaseBackup(db, { backupDirectory, reason: 'automatic' });
    assert.equal(getReadinessReport(db, backupDirectory, enabledAuth).status, 'ok');

    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '0';
    const disabled = getReadinessReport(db, backupDirectory, enabledAuth);
    assert.equal(disabled.status, 'ok');
    assert.equal(disabled.checks.backup, 'disabled');

    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '24';
    writeFileSync(invalidBackupDirectory, 'blocked');
    const failed = getReadinessReport(db, invalidBackupDirectory, enabledAuth);
    assert.equal(failed.status, 'degraded');
    assert.equal(failed.ready, true);
    assert.equal(failed.checks.backup, 'failed');
  } finally {
    if (previousInterval === undefined) delete process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
    else process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = previousInterval;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('readiness fails closed for authentication or schema incompatibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-health-required-'));
  const db = new Database(join(root, 'active.db'));
  const previousInterval = process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
  try {
    process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = '0';
    initializeDatabase(db);

    const misconfigured = getReadinessReport(db, join(root, 'backups'), {
      mode: 'misconfigured',
      reason: 'test',
    });
    assert.equal(misconfigured.status, 'unavailable');
    assert.equal(misconfigured.ready, false);

    db.prepare('UPDATE app_metadata SET value = ? WHERE key = ?')
      .run('999', 'schema-version');
    const incompatible = getReadinessReport(db, join(root, 'backups'), enabledAuth);
    assert.equal(incompatible.status, 'unavailable');
    assert.equal(incompatible.ready, false);
    assert.equal(incompatible.checks.schema, 'incompatible');
  } finally {
    if (previousInterval === undefined) delete process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
    else process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS = previousInterval;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
