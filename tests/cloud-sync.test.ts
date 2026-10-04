import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { isSyncUuid, type SyncContactMutation } from '../packages/domain/src/sync.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
function send(h: Harness, epoch: string, mutation: SyncContactMutation, workspace = 'test') {
  return h.call('v1/sync/push', { method: 'POST', workspace, body: { version: 1, epoch, mutation } });
}
function create(name: string): SyncContactMutation & { type: 'create' } {
  return { operationId: crypto.randomUUID(), contactId: crypto.randomUUID(), type: 'create', data: { name } };
}
async function webEdit(h: Harness, id: number, patch: Record<string, unknown>) {
  const current = await h.call(`contacts/${id}`);
  const response = await h.call(`contacts/${id}`, { method: 'PATCH',
    body: { ...patch, expected_edit_revision: current.body.contact.edit_revision } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

test('identity migration preserves existing contacts and seeds a replica without historical changes', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const files = readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of files.filter((name) => name < '0024_')) {
      sqlite.exec(readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
    }
    sqlite.exec("INSERT INTO workspaces (id, name) VALUES ('existing', 'Existing'); INSERT INTO contacts (id, workspace_id, name, notes) VALUES (42, 'existing', 'Ana', 'Context');");
    sqlite.exec(readFileSync(new URL('../drizzle/0024_contact_sync_foundation.sql', import.meta.url), 'utf8'));
    const contact = sqlite.prepare('SELECT * FROM contacts WHERE id = 42').get() as Record<string, unknown>;
    assert.equal(contact.name, 'Ana');
    assert.equal(contact.notes, 'Context');
    assert.ok(isSyncUuid(contact.public_id));
    const record = sqlite.prepare('SELECT * FROM sync_contact_records WHERE legacy_id = 42').get() as Record<string, unknown>;
    assert.equal(record.public_id, contact.public_id);
    assert.equal(record.revision, 1);
    assert.equal((sqlite.prepare('SELECT count(*) AS count FROM sync_changes').get() as { count: number }).count, 0);
    assert.throws(() => sqlite.prepare('UPDATE contacts SET public_id = ? WHERE id = 42').run(crypto.randomUUID()), /SYNC_IDENTITY_IMMUTABLE/);
  } finally { sqlite.close(); }
});

test('web writes appear in incremental sync with private photo bytes excluded and deleted records tombstoned', async () => {
  const h = await createCloudHarness();
  try {
    const initial = await h.call('v1/sync/bootstrap');
    assert.deepEqual(initial.body.records, []);
    assert.equal(initial.headers.get('Cache-Control'), 'no-store');
    const { epoch } = initial.body.cursor;
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ana', notes: 'Private context' } })).body.contact;
    assert.ok(isSyncUuid(contact.public_id));
    await h.db.prepare('UPDATE contacts SET photo_url = ? WHERE id = ?').bind('data:image/png;base64,private', contact.id).run();
    const pull = await h.call(`v1/sync/pull?epoch=${epoch}&sequence=0`);
    assert.equal(pull.status, 200);
    assert.equal(pull.body.changes.length, 2);
    assert.equal(pull.body.changes[1].record.id, contact.public_id);
    assert.equal(pull.body.changes[1].record.revision, 2);
    assert.equal(pull.body.changes[1].record.data.photo_available, 1);
    assert.equal(JSON.stringify(pull.body).includes('base64'), false);
    await h.call(`contacts/${contact.id}`, { method: 'DELETE' });
    const deletion = await h.call(`v1/sync/pull?epoch=${epoch}&sequence=${pull.body.cursor.sequence}`);
    assert.equal(deletion.body.changes.length, 1);
    assert.deepEqual(deletion.body.changes[0].record, { id: contact.public_id, legacyId: contact.id, revision: 3, deleted: true, data: null });
    assert.deepEqual((await h.call('v1/sync/bootstrap')).body.records, []);
    const other = await h.call('v1/sync/bootstrap', { workspace: 'other' });
    assert.deepEqual(other.body.records, []);
    assert.equal((await h.call(`v1/sync/pull?epoch=${epoch}&sequence=0`, { workspace: 'other' })).body.code, 'epoch_changed');
  } finally { await h.close(); }
});

test('offline creation commits once even if concurrent responses are lost or the same operation is retried later', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('v1/sync/bootstrap')).body.cursor.epoch;
    const mutation = create('From phone');
    const results = await Promise.all([send(h, epoch, mutation), send(h, epoch, mutation)]);
    for (const result of results) assert.equal(result.body.result.status, 'applied', JSON.stringify(result.body));
    assert.deepEqual(results[0].body.result, results[1].body.result);
    assert.equal(results.filter((result) => result.body.replayed).length, 1);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM contacts').first())?.count, 1);
    const record = results[0].body.result.record;
    await webEdit(h, record.legacyId, { notes: 'Web edit' });
    const replay = await send(h, epoch, mutation);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.result, results[0].body.result);
    assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())?.notes, 'Web edit');
    assert.equal((await send(h, epoch, { ...mutation, data: { name: 'Changed retry' } })).status, 409);
    assert.equal((await send(h, epoch, { ...mutation, operationId: crypto.randomUUID() })).body.result.status, 'conflict');
  } finally { await h.close(); }
});

test('disjoint offline edits merge and overlapping edits or stale deletions retain the server record', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('v1/sync/bootstrap')).body.cursor.epoch;
    const first = await send(h, epoch, create('Ana'));
    const record = first.body.result.record;
    await webEdit(h, record.legacyId, { notes: 'Web note' });
    const edit: SyncContactMutation = { type: 'update', operationId: crypto.randomUUID(), contactId: record.id,
      baseRevision: 1, base: { email: null }, patch: { email: 'ana@example.com' } };
    const merged = await send(h, epoch, edit);
    assert.equal(merged.body.result.status, 'applied', JSON.stringify(merged.body));
    assert.equal(merged.body.result.record.data.notes, 'Web note');
    assert.equal(merged.body.result.record.data.email, 'ana@example.com');
    const conflict = await send(h, epoch, { ...edit, operationId: crypto.randomUUID(), base: { notes: null }, patch: { notes: 'Offline note' } });
    assert.equal(conflict.body.result.status, 'conflict');
    assert.equal(conflict.body.result.record.data.notes, 'Web note');
    const deletion = await send(h, epoch, { type: 'delete', operationId: crypto.randomUUID(), contactId: record.id, baseRevision: 1 });
    assert.equal(deletion.body.result.status, 'conflict');
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM contacts').first())?.count, 1);
  } finally { await h.close(); }
});

test('sync deletion requires verified recovery storage, replays once, and cannot resurrect a tombstone', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('v1/sync/bootstrap')).body.cursor.epoch;
    const creation = create('Ana');
    const record = (await send(h, epoch, creation)).body.result.record;
    const deletion: SyncContactMutation = { type: 'delete', operationId: crypto.randomUUID(), contactId: record.id, baseRevision: record.revision };
    h.faults.failPut = true;
    assert.equal((await send(h, epoch, deletion)).status, 503);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM contacts').first())?.count, 1);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM sync_mutation_receipts').first())?.count, 1);
    h.faults.failPut = false;
    const deleted = await send(h, epoch, deletion);
    assert.equal(deleted.body.result.status, 'applied', JSON.stringify(deleted.body));
    assert.equal(deleted.body.result.record.deleted, true);
    const count = (await h.call('settings/backups')).body.backups.length;
    assert.equal((await send(h, epoch, deletion)).body.replayed, true);
    assert.equal((await h.call('settings/backups')).body.backups.length, count);
    assert.equal((await send(h, epoch, { ...creation, operationId: crypto.randomUUID() })).body.result.status, 'conflict');
    const pull = await h.call(`v1/sync/pull?epoch=${epoch}&sequence=0`);
    assert.equal(pull.body.changes.filter((change: { record: { deleted: boolean } }) => change.record.deleted).length, 1);
  } finally { await h.close(); }
});

test('bootstrap pagination detects intervening writes and every endpoint rejects malformed or unsupported cursors and fields', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) SELECT 'test', value FROM json_each(?)")
      .bind(JSON.stringify(Array.from({ length: 14 }, (_, index) => `Person ${index}`))).run();
    const first = (await h.call('v1/sync/bootstrap')).body;
    assert.equal(first.records.length, 10);
    const query = new URLSearchParams(first.next).toString();
    const second = await h.call(`v1/sync/bootstrap?${query}`);
    assert.equal(second.body.records.length, 4);
    assert.equal(second.body.next, null);
    assert.equal(new Set([...first.records, ...second.body.records].map((record) => record.id)).size, 14);
    await h.call('contacts', { method: 'POST', body: { name: 'New person' } });
    assert.equal((await h.call(`v1/sync/bootstrap?${query}`)).body.code, 'bootstrap_changed');
    assert.equal((await h.call(`v1/sync/pull?epoch=${first.cursor.epoch}&sequence=999999`)).status, 400);
    assert.equal((await h.call(`v1/sync/pull?epoch=${first.cursor.epoch}&sequence=-1`)).status, 400);
    assert.equal((await h.call('v1/sync/pull')).status, 400);
    assert.equal((await h.call('v1/sync/bootstrap', { method: 'POST', body: {} })).status, 405);
    const mutation = create('Protected');
    assert.equal((await send(h, first.cursor.epoch, { ...mutation, data: { name: 'Protected', workspace_id: 'other' } })).status, 400);
    assert.equal((await send(h, first.cursor.epoch, { ...mutation, data: { name: 'Protected', photo_url: 'https://example.com/image.png' } })).status, 400);
    assert.equal((await send(h, first.cursor.epoch, { ...mutation, data: { name: 'Protected', notes: 'x'.repeat(270_000) } })).status, 413);
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'").run();
    assert.equal((await h.call('v1/sync/bootstrap')).status, 423);
    assert.equal((await send(h, first.cursor.epoch, mutation)).status, 423);
  } finally { await h.close(); }
});

test('restore preserves modern IDs, upgrades old snapshots deterministically, and rejects prior device cursors and pending writes', async () => {
  const h = await createCloudHarness();
  try {
    const initial = (await h.call('v1/sync/bootstrap')).body.cursor;
    const record = (await send(h, initial.epoch, create('Ana'))).body.result.record;
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const otherEpoch = (await h.call('v1/sync/bootstrap', { workspace: 'other' })).body.cursor.epoch;
    const restore = await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    const restored = (await h.call('v1/sync/bootstrap')).body;
    assert.notEqual(restored.cursor.epoch, initial.epoch);
    assert.equal(restored.records[0].id, record.id);
    assert.equal(restored.cursor.sequence, 0);
    assert.equal((await h.call(`v1/sync/pull?epoch=${initial.epoch}&sequence=0`)).body.code, 'epoch_changed');
    assert.equal((await send(h, initial.epoch, create('Stale device'))).body.code, 'epoch_changed');
    assert.equal((await h.db.prepare("SELECT count(*) AS count FROM sync_mutation_receipts WHERE workspace_id = 'test'").first())?.count, 0);
    assert.equal((await h.call('v1/sync/bootstrap', { workspace: 'other' })).body.cursor.epoch, otherEpoch);
    const download = await h.call(`settings/backups/${backup.filename}`);
    assert.equal(download.status, 200, JSON.stringify(download.body));
    const legacy = download.body;
    legacy.version = 4; delete legacy.tables.contact_device_links;
    delete legacy.tables.contacts[0].public_id;
    const firstId = (h.validateCloudSnapshot(legacy, 'test').tables.contacts[0] as Record<string, unknown>).public_id;
    assert.ok(isSyncUuid(firstId));
    assert.equal((h.validateCloudSnapshot(legacy, 'test').tables.contacts[0] as Record<string, unknown>).public_id, firstId);
    const legacyRestore = await h.call('settings/restore', { method: 'POST', headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' }, body: legacy });
    assert.equal(legacyRestore.status, 200, JSON.stringify(legacyRestore.body));
    assert.equal((await h.call('v1/sync/bootstrap')).body.records[0].id, firstId);
    const invalid = structuredClone(legacy);
    invalid.version = 5;
    assert.throws(() => h.validateCloudSnapshot(invalid, 'test'), /Missing public_id/);
  } finally { await h.close(); }
});

test('erasure removes the sync journal and receipts and invalidates old offline devices', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('v1/sync/bootstrap')).body.cursor.epoch;
    await send(h, epoch, create('Private person'));
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    for (const table of ['sync_contact_records', 'sync_changes', 'sync_mutation_receipts']) {
      assert.equal((await h.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE workspace_id = 'test'`).first())?.count, 0);
    }
    const current = (await h.call('v1/sync/bootstrap')).body;
    assert.notEqual(current.cursor.epoch, epoch);
    assert.deepEqual(current.records, []);
    assert.equal((await send(h, epoch, create('Old phone'))).body.code, 'epoch_changed');
  } finally { await h.close(); }
});
