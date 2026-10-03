import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

const tables = [
  'contacts', 'contact_groups', 'contact_relationships', 'contact_children',
  'interactions', 'reminders', 'daily_snoozes', 'contact_group_members',
  'relationship_facts', 'integration_connections', 'sync_jobs', 'plans',
];

test('all CRM tables have a database delete fence and another tenant remains writable', async () => {
  const h = await createCloudHarness();
  try {
    const triggers = await h.db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE '%_maintenance_delete'`).all<{ name: string }>();
    assert.deepEqual(triggers.results.map((row) => row.name).sort(),
      tables.map((table) => `${table}_maintenance_delete`).sort());
    const first = (await h.call('contacts', { method: 'POST', body: { name: 'Keep me' } })).body.contact;
    const other = (await h.call('contacts', { method: 'POST', workspace: 'other', body: { name: 'Other' } })).body.contact;
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'").run();
    await assert.rejects(h.db.prepare('DELETE FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind('test', first.id).run(), /CLOUD_WORKSPACE_ERASING/);
    await assert.rejects(h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'New')").run(),
      /CLOUD_WORKSPACE_ERASING/);
    const eraseDuringRestore = await h.call('settings/erase', {
      method: 'POST', body: { confirmation: 'ERASE ALL DATA' },
    });
    assert.equal(eraseDuringRestore.status, 409);
    await h.db.prepare('DELETE FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind('other', other.id).run();
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind('test', first.id).first<{ name: string }>())?.name, 'Keep me');
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = 'test'").run();
    await h.db.prepare('DELETE FROM contacts WHERE workspace_id = ? AND id = ?').bind('test', first.id).run();
  } finally { await h.close(); }
});

test('erasure can delete a populated graph before committing the erasing lifecycle', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ana' } })).body.contact;
    await h.db.prepare("INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Friends')").run();
    await h.db.prepare(`INSERT INTO contact_group_members (workspace_id, contact_id, group_id)
      SELECT 'test', ?, id FROM contact_groups WHERE workspace_id = 'test'`).bind(contact.id).run();
    await h.db.prepare("INSERT INTO interactions (workspace_id, contact_id, type, notes, date) VALUES ('test', ?, 'call', 'Hello', ?)")
      .bind(contact.id, new Date().toISOString()).run();
    const result = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.success, true);
    for (const table of tables) {
      const count = await h.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = 'test'`)
        .first<{ count: number }>();
      assert.equal(count?.count, 0, table);
    }
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
  } finally { await h.close(); }
});
