import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { DATABASE_SCHEMA_VERSION } from '../lib/database-schema.ts';
import { initializeWorkspaceFoundation } from '../lib/database-foundation.ts';
import {
  createDatabaseBackup,
  listDatabaseBackups,
} from '../lib/database-maintenance.ts';
import { initializeDemoData } from '../lib/demo-data.ts';
import { eraseWorkspaceData } from '../lib/workspace-erasure.ts';

test('workspace erasure removes app-managed copies and leaves a neutral valid database', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-erasure-'));
  const databasePath = join(root, 'relationships.db');
  const backupDirectory = join(root, 'backups');
  const restoreStaging = join(root, 'restore-staging');
  const db = new Database(databasePath);

  try {
    initializeDatabase(db);
    initializeWorkspaceFoundation(db);
    const workspaceId = db.prepare('SELECT id FROM workspaces').pluck().get() as number;
    const contactId = Number(db.prepare(`
      INSERT INTO contacts (name, email, notes, custom_fields)
      VALUES (?, ?, ?, ?)
    `).run(
      'Erase Me Person',
      'erase-me@example.test',
      'Private relationship detail',
      JSON.stringify({ secret: 'sensitive custom value' })
    ).lastInsertRowid);
    const groupId = Number(db.prepare('INSERT INTO contact_groups (name) VALUES (?)')
      .run('Private circle').lastInsertRowid);
    db.prepare('INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)')
      .run(contactId, groupId);
    db.prepare(`INSERT INTO interactions (contact_id, date, type, summary) VALUES (?, ?, ?, ?)`)
      .run(contactId, '2026-07-11', 'call', 'Confidential conversation');
    db.prepare(`INSERT INTO reminders (contact_id, title, remind_at) VALUES (?, ?, ?)`)
      .run(contactId, 'Private reminder', '2030-01-01T09:00:00.000Z');
    db.prepare(`
      INSERT INTO relationship_facts (contact_id, category, label, value)
      VALUES (?, ?, ?, ?)
    `).run(contactId, 'personal', 'Secret', 'Sensitive fact');
    db.prepare(`
      INSERT INTO plans (contact_id, type, planned_date, summary)
      VALUES (?, ?, ?, ?)
    `).run(contactId, 'meetup', '2030-02-01', 'Private plan');
    db.prepare('INSERT INTO contact_children (contact_id, name, birthday) VALUES (?, ?, ?)')
      .run(contactId, 'Private child', '2020-05-12');
    db.prepare(`
      INSERT INTO integration_connections (
        workspace_id, provider, label, status, account_email, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      'custom',
      'Private connector',
      'connected',
      'owner@example.test',
      JSON.stringify({ token_hint: 'private' })
    );
    db.prepare(`
      INSERT INTO sync_jobs (workspace_id, provider, job_type, status, summary, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workspaceId, 'custom', 'sync', 'success', 'Imported private records', '{}');
    db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
      .run('auth-login-limit:client:private-hash', '{"count":4,"resetAt":9999999999999}');

    createDatabaseBackup(db, { backupDirectory });
    writeFileSync(join(backupDirectory, 'bonds-manual-crashed.db.partial'), 'private partial');
    writeFileSync(join(backupDirectory, 'keep-me.txt'), 'operator file');
    mkdirSync(restoreStaging);
    writeFileSync(join(restoreStaging, 'abandoned.db'), 'private staged upload');

    const result = eraseWorkspaceData(db, { backupDirectory, databasePath });

    assert.equal(result.erased, true);
    assert.equal(result.deletedRows.contacts, 1);
    assert.equal(result.deletedRows.interactions, 1);
    assert.equal(result.deletedRows.contact_children, 1);
    assert.equal(result.deletedBackups, 1);
    assert(result.deletedBackupArtifacts >= 3);
    assert.equal(listDatabaseBackups(backupDirectory).length, 0);
    assert.deepEqual(readdirSync(backupDirectory), ['keep-me.txt']);
    assert.equal(existsSync(restoreStaging), false);

    for (const table of [
      'contacts',
      'contact_relationships',
      'contact_children',
      'contact_groups',
      'interactions',
      'reminders',
      'contact_group_members',
      'relationship_facts',
      'integration_connections',
      'sync_jobs',
      'plans',
    ]) {
      assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
    }
    assert.deepEqual(db.prepare('SELECT id, name, plan, persona FROM workspaces').get(), {
      id: 1,
      name: 'My Everclose CRM',
      plan: 'local',
      persona: 'private-first',
    });
    assert.deepEqual(
      db.prepare('SELECT key, value FROM app_metadata ORDER BY key').all(),
      [
        { key: 'demo-data-v1', value: 'erased' },
        { key: 'schema-version', value: DATABASE_SCHEMA_VERSION },
      ]
    );
    assert.equal(db.pragma('freelist_count', { simple: true }), 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(initializeDemoData(db, { NODE_ENV: 'development' }), 'already-initialized');
    assert.equal(db.prepare('SELECT COUNT(*) FROM contacts').pluck().get(), 0);

    const nextContactId = db.prepare('INSERT INTO contacts (name) VALUES (?)')
      .run('Fresh start').lastInsertRowid;
    assert.equal(Number(nextContactId), 1);
    db.prepare('DELETE FROM contacts').run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const diskContent = readFileSync(databasePath);
    for (const secret of [
      'Erase Me Person',
      'erase-me@example.test',
      'Private relationship detail',
      'Sensitive fact',
    ]) {
      assert.equal(diskContent.includes(Buffer.from(secret)), false, secret);
    }
    const walPath = `${databasePath}-wal`;
    assert.equal(!existsSync(walPath) || statSync(walPath).size === 0, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
