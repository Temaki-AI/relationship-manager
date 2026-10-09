import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('cloud deletion creates a verified graph snapshot and restore preserves the displaced state', async () => {
  const h = await createCloudHarness();
  try {
    const key = crypto.randomUUID();
    const contact = (await h.call('contacts', { method: 'POST', key, body: { name: 'Ada', nickname: 'Addie', birthday: '1990-03-04', notes: 'Important context' } })).body.contact;
    const friend = (await h.call('contacts', { method: 'POST', body: { name: 'Grace' } })).body.contact;
    const childProfile = (await h.call('contacts', { method: 'POST', body: { name: 'Alex profile', birthday: '2020-02-29' } })).body.contact;
    await h.call(`contacts/${contact.id}/relationships`, { method: 'POST', body: { related_contact_id: friend.id, relationship_label: 'Friend', reciprocal_label: 'Friend' } });
    await h.call(`contacts/${contact.id}/children`, { method: 'POST', body: { name: 'Alex', birthday: '2020-02-29', linked_contact_id: childProfile.id } });
    await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, type: 'call', date: '2026-08-01', notes: 'Catch up' } });
    const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Birthday', remind_at: '2027-03-01T10:00:00Z' } })).body.reminder;
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await h.call('today/snooze', { method: 'PUT', body: { id: `reminder-${reminder.id}`, until, timeZone: 'UTC' } })).status, 200);
    await h.call('plans', { method: 'POST', body: { contact_id: contact.id, type: 'call', planned_date: '2026-09-15' } });
    await h.db.prepare("INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Friends')").run();
    await h.db.prepare("INSERT INTO contact_group_members (workspace_id, contact_id, group_id) VALUES ('test', ?, (SELECT id FROM contact_groups WHERE workspace_id = 'test'))").bind(contact.id).run();
    await h.db.prepare("INSERT INTO relationship_facts (workspace_id, contact_id, category, label, value) VALUES ('test', ?, 'interest', 'Enjoys', 'Hiking')").bind(contact.id).run();
    await h.db.prepare("INSERT INTO integration_connections (workspace_id, provider, label) VALUES ('test', 'google', 'Google')").run();
    await h.db.prepare("INSERT INTO sync_jobs (workspace_id, provider, job_type, status) VALUES ('test', 'google', 'contacts', 'completed')").run();
    const before = await h.call(`contacts/${contact.id}`);
    const deleted = await h.call(`contacts/${contact.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.recoveryPoint.reason, 'pre-delete');
    assert.match(deleted.body.recoveryPoint.sha256, /^[a-f0-9]{64}$/);
    const savedFile = await h.assets.get(`test/backups/${deleted.body.recoveryPoint.filename}`);
    const legacy = JSON.parse(new TextDecoder().decode(await savedFile.arrayBuffer()));
    legacy.version = 2; delete legacy.tables.contact_device_links;
    delete legacy.tables.daily_snoozes;
    legacy.tables.contact_children.forEach((row: Record<string, unknown>) => { delete row.linked_contact_id; });
    assert.deepEqual(h.validateCloudSnapshot(legacy, 'test').tables.daily_snoozes, [], 'older backups remain restorable');
    assert.equal(h.validateCloudSnapshot(legacy, 'test').tables.contact_children[0].linked_contact_id, null);
    const invalidLink = JSON.parse(new TextDecoder().decode(await (await h.assets.get(`test/backups/${deleted.body.recoveryPoint.filename}`))!.arrayBuffer()));
    invalidLink.tables.contact_children[0].linked_contact_id = 99999;
    assert.throws(() => h.validateCloudSnapshot(invalidLink, 'test'), /linked child profile/i);
    assert.equal((await h.call(`contacts/${contact.id}`)).status, 404);
    const restore = await h.call('settings/restore', { method: 'POST', body: { filename: deleted.body.recoveryPoint.filename, confirmation: 'RESTORE' } });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    const after = await h.call(`contacts/${contact.id}`);
    assert.deepEqual(after.body.contact, before.body.contact);
    for (const field of ['children', 'relationships', 'interactions', 'reminders', 'plans']) assert.deepEqual(after.body[field], before.body[field], field);
    for (const table of ['contact_groups', 'contact_group_members', 'relationship_facts', 'integration_connections', 'sync_jobs']) {
      assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = 'test'`).first()).count, 1, table);
    }
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM daily_snoozes WHERE workspace_id = 'test'").first()).count, 1);
    assert.equal(restore.body.recoveryPoint.reason, 'pre-restore');
    assert.equal((await h.call('contacts', { method: 'POST', key, body: { name: 'Ada', nickname: 'Addie', birthday: '1990-03-04', notes: 'Important context' } })).status, 409);
    const undo = await h.call('settings/restore', { method: 'POST', body: { filename: restore.body.recoveryPoint.filename, confirmation: 'RESTORE' } });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal((await h.call(`contacts/${contact.id}`)).status, 404);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM daily_snoozes WHERE workspace_id = 'test'").first()).count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first()).count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_maintenance_guards').first()).count, 0);
  } finally { await h.close(); }
});

test('cloud recovery refuses oversized workspaces before reading or deleting their data', async () => {
  const h = await createCloudHarness();
  try {
    for (let index = 0; index < 34; index++) await h.db.prepare("INSERT INTO contacts (workspace_id, name, notes) VALUES ('test', ?, ?)").bind(`Contact ${index}`, 'x'.repeat(500_000)).run();
    const response = await h.call('contacts/1', { method: 'DELETE' });
    assert.equal(response.status, 413, JSON.stringify(response.body));
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 34);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first()).count, 0);
    assert.equal((await h.assets.list({ prefix: 'test/' })).objects.length, 0);
  } finally { await h.close(); }
});

test('a manual backup changed during R2 upload is not published as a recovery point', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    h.faults.afterPut = async () => {
      await h.db.prepare("UPDATE contacts SET notes = 'New detail' WHERE workspace_id = 'test' AND id = ?")
        .bind(contact.id).run();
    };
    const response = await h.call('settings/backups', { method: 'POST' });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
    assert.equal((await h.assets.list({ prefix: 'test/backups/' })).objects.length, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM cloud_backup_files WHERE state = 'ready'").first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_maintenance_guards').first<{ count: number }>())?.count, 0);
    h.faults.afterPut = undefined;
    const retry = await h.call('settings/backups', { method: 'POST' });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.body.backups.length, 1);
    const filename = retry.body.backup.filename;
    const downloaded = await h.call(`settings/backups/${filename}`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body.tables.contacts[0].notes, 'New detail');
    assert.equal((await h.call(`settings/backups/${filename}`, { workspace: 'other' })).status, 404);
    const object = await h.assets.get(`test/backups/${filename}`);
    await h.assets.put(`test/backups/${filename}`, 'corrupted', { customMetadata: object!.customMetadata });
    assert.equal((await h.call(`settings/backups/${filename}`)).status, 400);
    const failed = 'bonds-cloud-2026-10-02T12-00-00-000Z.json';
    await h.db.prepare("INSERT INTO cloud_backup_files (workspace_id, filename, state) VALUES ('test', ?, 'failed')")
      .bind(failed).run();
    await h.assets.put(`test/backups/${failed}`, 'corrupted', { customMetadata: object!.customMetadata });
    assert.equal((await h.call(`settings/backups/${failed}`)).status, 404);
  } finally { await h.close(); }
});

test('cloud bulk deletion handles more than one hundred IDs without D1 parameter overflow', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) SELECT 'test', value FROM json_each(?)").bind(JSON.stringify(Array.from({ length: 120 }, (_, index) => `Contact ${index}`))).run();
    const result = await h.call('contacts/bulk', { method: 'POST', body: { operation: 'delete', contactIds: Array.from({ length: 120 }, (_, index) => index + 1) } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.affected, 120);
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename: result.body.recoveryPoint.filename, confirmation: 'RESTORE' } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 120);
  } finally { await h.close(); }
});

test('cloud storage failure and concurrent changes prevent deletion', async () => {
  const h = await createCloudHarness();
  try {
    const id = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact.id;
    h.faults.failPut = true;
    assert.ok((await h.call(`contacts/${id}`, { method: 'DELETE' })).status >= 500);
    assert.equal((await h.call(`contacts/${id}`)).status, 200);
    h.faults.failPut = false;
    h.faults.afterPut = async () => { await h.db.prepare("UPDATE contacts SET notes = 'New information' WHERE id = ?").bind(id).run(); };
    const conflict = await h.call(`contacts/${id}`, { method: 'DELETE' });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal((await h.call(`contacts/${id}`)).body.contact.notes, 'New information');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first()).count, 0);
  } finally { await h.close(); }
});

test('cloud restore rejects corrupted files, foreign workspaces, dangling references and colliding IDs', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const foreign = (await h.call('contacts', { method: 'POST', body: { name: 'Private person' }, workspace: 'other' })).body.contact;
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const object = await h.assets.get(`test/backups/${backup.filename}`);
    const snapshot = JSON.parse(await object!.text());
    const upload = (body: unknown) => h.call('settings/restore', { method: 'POST', headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' }, body });
    assert.equal((await upload({ ...snapshot, workspaceId: 'other' })).status, 400);
    const colliding = structuredClone(snapshot);
    colliding.tables.contacts[0].id = foreign.id;
    assert.ok((await upload(colliding)).status >= 400);
    assert.equal((await h.call(`contacts/${contact.id}`)).body.contact.name, 'Ada');
    assert.equal((await h.call(`contacts/${foreign.id}`, { workspace: 'other' })).body.contact.name, 'Private person');
    const dangling = structuredClone(snapshot);
    dangling.tables.contact_children.push({ id: 99, workspace_id: 'test', contact_id: 99999, linked_contact_id: null, name: 'Missing parent', birthday: null, created_at: '2026-01-01', updated_at: '2026-01-01' });
    assert.equal((await upload(dangling)).status, 400);
    await h.assets.put(`test/backups/${backup.filename}`, JSON.stringify({ ...snapshot, createdAt: 'tampered' }), { customMetadata: object!.customMetadata });
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 400);
    assert.equal((await h.call(`contacts/${contact.id}`)).body.contact.name, 'Ada');
  } finally { await h.close(); }
});

test('cloud backup pagination and retention protect in-use and newest recovery kinds', async () => {
  const h = await createCloudHarness();
  try {
    h.faults.listPageSize = 2;
    let oldest = '';
    for (let i = 1; i <= 25; i++) {
      const createdAt = `2026-08-${String(i).padStart(2, '0')}T12:00:00.000Z`;
      const filename = `bonds-cloud-${createdAt.replace(/[:.]/g, '-')}.json`;
      if (i === 1) oldest = filename;
      await h.assets.put(`test/backups/${filename}`, '{}', { customMetadata: { createdAt, reason: i === 2 ? 'pre-delete' : 'manual', sha256: 'a'.repeat(64), rowCounts: '{}' } });
    }
    await h.db.prepare("INSERT INTO cloud_backup_files (workspace_id, filename, state) VALUES ('test', ?, 'ready')").bind(oldest).run();
    await h.db.prepare("INSERT INTO cloud_backup_pins (workspace_id, filename, token) VALUES ('test', ?, 'active-operation')").bind(oldest).run();
    assert.equal((await h.call('settings/backups')).body.backups.length, 25);
    assert.equal((await h.call(`settings/backups/${oldest}`, { method: 'DELETE' })).status, 409);
    const created = await h.call('settings/backups', { method: 'POST' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.backups.length, 20);
    assert.ok(created.body.backups.some((entry: { filename: string }) => entry.filename === oldest));
    assert.ok(created.body.backups.some((entry: { reason: string }) => entry.reason === 'pre-delete'));
  } finally { await h.close(); }
});

test('cloud erasure resumes across storage pages and failures without exposing a false success', async () => {
  const h = await createCloudHarness();
  try {
    const id = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact.id;
    await h.call('interactions', { method: 'POST', body: { contact_id: id, type: 'call', date: '2026-09-01' } });
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await h.call('today/snooze', { method: 'PUT', body: { id: `overdue-${id}`, until, timeZone: 'UTC' } })).status, 200);
    for (let i = 0; i < 11; i++) await h.assets.put(`test/files/${i}`, 'private');
    await h.assets.put('other/files/private', 'other workspace');
    h.faults.listPageSize = 2;
    h.faults.failDelete = true;
    const erase = () => h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    const failed = await erase();
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Cannot write now' } })).status, 409);
    h.faults.failDelete = false;
    const pending = await erase();
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(pending.body.success, false);
    assert.equal((await h.call('settings/backups')).body.lifecycle, 'erasing');
    const done = await erase();
    assert.equal(done.body.success, true, JSON.stringify(done.body));
    assert.equal((await h.assets.list({ prefix: 'test/' })).objects.length, 0);
    assert.ok(await h.assets.get('other/files/private'));
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE workspace_id = 'test'").first()).count, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM daily_snoozes WHERE workspace_id = 'test'").first()).count, 0);
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Fresh start' } })).status, 201);
  } finally { await h.close(); }
});
