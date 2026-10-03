import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { initializeWorkspaceFoundation } from '../lib/database-foundation.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

test('fresh workspaces describe the local product without manufactured connections', () => {
  const db = createDatabase();

  try {
    initializeWorkspaceFoundation(db);
    initializeWorkspaceFoundation(db);

    const workspace = db.prepare('SELECT name, plan, persona FROM workspaces').get();
    assert.deepEqual(workspace, {
      name: 'My Everclose CRM',
      plan: 'local',
      persona: 'private-first',
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM integration_connections').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_jobs').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('legacy placeholder state is removed without touching customized connection records', () => {
  const db = createDatabase();

  try {
    initializeWorkspaceFoundation(db);
    const workspaceId = db.prepare('SELECT id FROM workspaces').pluck().get() as number;
    db.prepare('UPDATE workspaces SET name = ?, plan = ?, persona = ? WHERE id = ?')
      .run('Bonds HQ', 'premium', 'automation-first', workspaceId);

    db.prepare(`
      INSERT INTO integration_connections (
        workspace_id, provider, label, status, sync_frequency_minutes, metadata, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      workspaceId,
      'local',
      'Local CRM',
      'connected',
      15,
      JSON.stringify({ description: 'Primary local data store and migration bridge.' })
    );
    db.prepare(`
      INSERT INTO integration_connections (
        workspace_id, provider, label, status, account_email, sync_frequency_minutes, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      'custom',
      'User-managed connector',
      'connected',
      'owner@example.test',
      60,
      JSON.stringify({ configured: true })
    );
    db.prepare(`
      INSERT INTO sync_jobs (
        workspace_id, provider, job_type, status, summary, finished_at, metadata
      ) VALUES (?, 'local', 'migration', 'success', ?, CURRENT_TIMESTAMP, ?)
    `).run(
      workspaceId,
      'Initialized Bonds V2 workspace foundation',
      JSON.stringify({ version: '2.0-foundation' })
    );

    initializeWorkspaceFoundation(db);

    assert.deepEqual(
      db.prepare('SELECT name, plan, persona FROM workspaces').get(),
      { name: 'My Everclose CRM', plan: 'local', persona: 'private-first' }
    );
    assert.deepEqual(
      db.prepare('SELECT provider, label, account_email FROM integration_connections').all(),
      [{ provider: 'custom', label: 'User-managed connector', account_email: 'owner@example.test' }]
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM sync_jobs').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('custom workspace identity is preserved', () => {
  const db = createDatabase();

  try {
    initializeWorkspaceFoundation(db);
    db.prepare('UPDATE workspaces SET name = ?, plan = ?, persona = ?')
      .run('Family Circle', 'self-hosted', 'custom');

    initializeWorkspaceFoundation(db);

    assert.deepEqual(
      db.prepare('SELECT name, plan, persona FROM workspaces').get(),
      { name: 'Family Circle', plan: 'self-hosted', persona: 'custom' }
    );
  } finally {
    db.close();
  }
});
