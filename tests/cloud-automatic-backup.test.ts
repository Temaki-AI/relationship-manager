import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

const now = new Date('2026-10-02T12:00:00.000Z');

test('scheduled cloud backups are leased once, visible per workspace, and become due after deletion', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'true';
    assert.equal((await h.automaticBackupStatus('test', true, now)).state, 'due');
    const [first, overlapping] = await Promise.all([h.runAutomaticBackups(now), h.runAutomaticBackups(now)]);
    assert.equal(first.created + overlapping.created, 2);
    assert.equal(first.failed + overlapping.failed, 0);
    assert.equal((await h.runAutomaticBackups(new Date(now.getTime() + 60_000))).claimed, 0);

    const testBackups = (await h.call('settings/backups')).body;
    const otherBackups = (await h.call('settings/backups', { workspace: 'other' })).body;
    assert.equal(testBackups.backups.length, 1);
    assert.equal(otherBackups.backups.length, 1);
    assert.equal(testBackups.backups[0].reason, 'automatic');
    assert.equal(testBackups.automaticBackup.state, 'current');
    assert.equal(otherBackups.automaticBackup.state, 'current');
    assert.equal(testBackups.backups[0].protected, false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first<{ count: number }>())?.count, 0);

    const removed = await h.call(`settings/backups/${testBackups.backups[0].filename}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.automaticBackup.state, 'due');
    assert.equal((await h.automaticBackupStatus('other', true, now)).state, 'current');
    const next = await h.db.prepare("SELECT next_attempt_at FROM cloud_backup_schedules WHERE workspace_id = 'test'")
      .first<{ next_attempt_at: string }>();
    assert.equal((await h.runAutomaticBackups(new Date(Date.parse(next!.next_attempt_at) + 60_000))).created, 1);
    assert.equal((await h.call('settings/backups')).body.automaticBackup.state, 'current');
  } finally { await h.close(); }
});

test('scheduled backup storage failures retry without claiming protection', async () => {
  const h = await createCloudHarness();
  try {
    h.faults.failPut = true;
    const failed = await h.runAutomaticBackups(now);
    assert.equal(failed.failed, 2);
    const state = await h.automaticBackupStatus('test', true, now);
    assert.equal(state.state, 'failed');
    assert.equal(state.issue, 'backup_failed');
    assert.equal(state.latestBackupAt, null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first<{ count: number }>())?.count, 0);
    h.faults.failPut = false;
    assert.equal((await h.runAutomaticBackups(new Date(now.getTime() + 29 * 60_000))).claimed, 0);
    assert.equal((await h.runAutomaticBackups(new Date(now.getTime() + 30 * 60_000))).created, 2);
    assert.equal((await h.automaticBackupStatus('test', true, new Date(now.getTime() + 30 * 60_000))).state, 'current');
  } finally { await h.close(); }
});

test('a scheduled backup invalidated during upload stays uncovered and retries', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'true';
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Ada')").run();
    let changed = false;
    h.faults.afterPut = async (key) => {
      if (changed || !key.startsWith('test/backups/')) return;
      changed = true;
      await h.db.prepare("UPDATE contacts SET notes = 'Changed' WHERE workspace_id = 'test'").run();
    };
    const result = await h.runAutomaticBackups(now);
    assert.equal(result.failed, 1);
    assert.equal(result.created, 1);
    const testBackups = (await h.call('settings/backups')).body;
    assert.equal(testBackups.backups.length, 0);
    assert.equal(testBackups.automaticBackup.state, 'failed');
    assert.equal(testBackups.automaticBackup.issue, 'backup_failed');
    assert.equal((await h.call('settings/backups', { workspace: 'other' })).body.automaticBackup.state, 'current');
    assert.equal((await h.assets.list({ prefix: 'test/backups/' })).objects.length, 0);
    h.faults.afterPut = undefined;
    assert.equal((await h.runAutomaticBackups(new Date(now.getTime() + 30 * 60_000))).created, 1);
    assert.equal((await h.call('settings/backups')).body.automaticBackup.state, 'current');
  } finally { await h.close(); }
});

test('a missing automatic R2 file cannot retain a green protection state', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'true';
    assert.equal((await h.runAutomaticBackups(now)).created, 2);
    const before = (await h.call('settings/backups')).body;
    assert.equal(before.automaticBackup.state, 'current');
    await h.assets.delete(`test/backups/${before.backups[0].filename}`);
    const after = (await h.call('settings/backups')).body;
    assert.equal(after.automaticBackup.state, 'failed');
    assert.equal(after.automaticBackup.issue, 'backup_missing');
    assert.equal(after.backups.length, 0);
    assert.equal((await h.call('settings/backups', { workspace: 'other' })).body.automaticBackup.state, 'current');
  } finally { await h.close(); }
});

test('stale partial backup files and pins are cleaned up without deleting verified snapshots', async () => {
  const h = await createCloudHarness();
  try {
    const old = '2026-10-01 10:00:00';
    const ready = 'bonds-cloud-2026-10-01T10-00-00-000Z-ready.json';
    const partial = 'bonds-cloud-2026-10-01T10-00-00-000Z-partial.json';
    for (const [filename, state] of [[ready, 'ready'], [partial, 'writing']]) {
      await h.db.prepare('INSERT INTO cloud_backup_files (workspace_id, filename, state, created_at) VALUES (?, ?, ?, ?)')
        .bind('test', filename, state, old).run();
      await h.assets.put(`test/backups/${filename}`, 'test');
    }
    await h.db.prepare('INSERT INTO cloud_backup_pins (workspace_id, filename, token, created_at) VALUES (?, ?, ?, ?)')
      .bind('test', ready, 'old-ready', old).run();
    await h.db.prepare('INSERT INTO cloud_backup_pins (workspace_id, filename, token, created_at) VALUES (?, ?, ?, ?)')
      .bind('test', partial, 'old-writing', old).run();
    h.faults.failDelete = true;
    const interrupted = await h.cleanupStaleBackups(now);
    assert.equal(interrupted.releasedPins, 2);
    assert.equal(interrupted.failed, 1);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_backup_files WHERE filename = ?').bind(partial).first<{ state: string }>())?.state, 'deleting');
    h.faults.failDelete = false;
    const resumed = await h.cleanupStaleBackups(now);
    assert.equal(resumed.removed, 1);
    assert.equal(await h.assets.get(`test/backups/${partial}`), null);
    assert.ok(await h.assets.get(`test/backups/${ready}`));
  } finally { await h.close(); }
});

test('restore reopens the backup schedule and erasure removes it', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'true';
    assert.equal((await h.runAutomaticBackups(now)).created, 2);
    const filename = (await h.call('settings/backups')).body.backups[0].filename;
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Added later')").run();
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename, confirmation: 'RESTORE' } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.automaticBackup.state, 'due');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'").first<{ count: number }>())?.count, 0);
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM cloud_backup_schedules WHERE workspace_id = 'test'").first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('oversized workspaces are explicitly uncovered instead of appearing current', async () => {
  const h = await createCloudHarness();
  try {
    for (let index = 0; index < 17; index++) {
      await h.db.prepare("INSERT INTO contacts (workspace_id, name, notes) VALUES ('test', ?, ?)")
        .bind(`Large ${index}`, 'x'.repeat(1_000_000)).run();
    }
    const result = await h.runAutomaticBackups(now);
    assert.equal(result.oversized, 1);
    assert.equal(result.created, 1);
    const state = await h.automaticBackupStatus('test', true, now);
    assert.equal(state.state, 'failed');
    assert.equal(state.issue, 'too_large');
    assert.equal(state.latestBackupAt, null);
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
  } finally { await h.close(); }
});
