import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { isSyncUuid } from '../packages/domain/src/sync.ts';
import type { SyncEntityMutation } from '../packages/domain/src/sync-v2.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';
import { readBootstrapV2, readPullV2, readPushResultV2 } from '../packages/domain/src/sync-v2-client.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function send(h: Harness, epoch: string, mutation: SyncEntityMutation, workspace = 'test') {
  const response = await h.call('v2/sync/push', { method: 'POST', workspace, body: { version: 2, epoch, mutation } });
  if (response.status === 200) readPushResultV2(response.body, mutation.operationId, mutation.entity, mutation.entityId);
  return response;
}
function create(entity: 'interaction' | 'reminder', contact: string): SyncEntityMutation & { type: 'create' } {
  return { operationId: crypto.randomUUID(), entity, entityId: crypto.randomUUID(), type: 'create', data: entity === 'interaction'
    ? { contact_id: contact, date: '2026-10-03', occurred_at: '2026-10-03T10:12:34.123Z', type: 'call', summary: 'Catch up', notes: 'Private history' }
    : { contact_id: contact, title: 'Call back', remind_at: '2026-10-05T10:00:00.000Z', notes: 'Private reminder' } };
}
async function person(h: Harness, workspace = 'test') {
  const response = await h.call('contacts', { method: 'POST', workspace, body: { name: 'Ana' } });
  assert.equal(response.status, 201); return response.body.contact;
}

test('history migration preserves integer references and seeds distinct UUID identities without replaying historical writes', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((s) => s.endsWith('.sql') && s < '0026_').sort()) {
      db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    }
    db.exec("INSERT INTO workspaces (id, name) VALUES ('existing', 'Existing'); INSERT INTO contacts (id, workspace_id, name) VALUES (42, 'existing', 'Ana'); INSERT INTO interactions (id, workspace_id, contact_id, date, type, notes) VALUES (42, 'existing', 42, '2026-10-01', 'call', 'Context'); INSERT INTO reminders (id, workspace_id, contact_id, title, remind_at) VALUES (42, 'existing', 42, 'Call back', '2026-10-05T10:00:00Z');");
    const before = (db.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    db.exec(readFileSync(new URL('../drizzle/0026_history_reminder_sync.sql', import.meta.url), 'utf8'));
    const ids = [];
    for (const table of ['interactions', 'reminders']) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = 42`).get() as { contact_id: number; public_id: string };
      assert.equal(row.contact_id, 42); assert.ok(isSyncUuid(row.public_id)); ids.push(row.public_id);
      assert.throws(() => db.prepare(`UPDATE ${table} SET public_id = ? WHERE id = 42`).run(crypto.randomUUID()), /SYNC_IDENTITY_IMMUTABLE/);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n, before);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sync_entity_records WHERE revision = 1').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT occurred_at FROM interactions').get() as { occurred_at: unknown }).occurred_at, null);
  } finally { db.close(); }
});

test('v2 bootstraps web history/reminders in bounded parent-first pages and v1 ignores their journal entries', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const start = (await h.call('v1/sync/bootstrap')).body.cursor;
    for (let i = 0; i < 6; i++) {
      assert.equal((await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: '2026-10-03', type: 'email', summary: `Message ${i}` } })).status, 201);
      assert.equal((await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: `Reminder ${i}`, remind_at: '2026-10-05T10:00:00Z' } })).status, 201);
    }
    const first = await h.call('v2/sync/bootstrap');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.entities, ['contact', 'interaction', 'reminder']);
    assert.equal(first.body.records.length, 10);
    assert.equal(first.body.records[0].entity, 'contact');
    const second = await h.call(`v2/sync/bootstrap?${new URLSearchParams(first.body.next)}`);
    readBootstrapV2(first.body); readBootstrapV2(second.body);
    assert.equal(second.body.records.length, 3); assert.equal(second.body.next, null);
    for (const r of [...first.body.records, ...second.body.records].slice(1)) {
      assert.ok(isSyncUuid(r.id)); assert.equal(r.data.contact_id, contact.public_id);
    }
    const legacy = await h.call(`v1/sync/pull?epoch=${start.epoch}&sequence=${start.sequence}`);
    assert.ok(legacy.body.changes.every((c: { entity: string }) => c.entity === 'contact'));
    assert.equal(legacy.body.cursor.sequence, first.body.cursor.sequence);
    assert.deepEqual((await h.call('v2/sync/bootstrap', { workspace: 'other' })).body.records, []);
    await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Changed page set', remind_at: '2026-10-06T10:00:00Z' } });
    assert.equal((await h.call(`v2/sync/bootstrap?${new URLSearchParams(first.body.next)}`)).body.code, 'bootstrap_changed');
  } finally { await h.close(); }
});

test('phone history commits once across concurrent retries and web edits preserve exact timestamps until the date changes', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    const mutation = create('interaction', contact.public_id);
    const results = await Promise.all([send(h, epoch, mutation), send(h, epoch, mutation)]);
    for (const r of results) assert.equal(r.body.result.status, 'applied', JSON.stringify(r.body));
    assert.deepEqual(results[0].body.result, results[1].body.result);
    assert.equal(results.filter((r) => r.body.replayed).length, 1);
    const record = results[0].body.result.record;
    const web = (await h.call(`interactions/${record.legacyId}`)).body.interaction;
    assert.equal(web.occurred_at, mutation.data.occurred_at);
    assert.equal((await h.db.prepare('SELECT last_contacted FROM contacts WHERE id = ?').bind(contact.id).first())?.last_contacted, '2026-10-03');
    const edited = await h.call(`interactions/${record.legacyId}`, { method: 'PATCH', body: { ...web, summary: 'Web summary', expected_edit_revision: web.edit_revision } });
    assert.equal(edited.status, 200); assert.equal(edited.body.interaction.occurred_at, web.occurred_at);
    const moved = await h.call(`interactions/${record.legacyId}`, { method: 'PATCH', body: { ...edited.body.interaction, date: '2026-10-04', expected_edit_revision: edited.body.interaction.edit_revision } });
    assert.equal(moved.status, 200); assert.equal(moved.body.interaction.occurred_at, null);
    const replay = await send(h, epoch, mutation);
    assert.deepEqual(replay.body.result, results[0].body.result);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM interactions').first())?.n, 1);
    assert.equal((await send(h, epoch, { ...mutation, data: { ...mutation.data, summary: 'Different retry' } })).status, 409);
  } finally { await h.close(); }
});

test('reminder completion merges around disjoint web edits while overlapping fields retain the current revision', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    const record = (await send(h, epoch, create('reminder', contact.public_id))).body.result.record;
    await h.call(`reminders/${record.legacyId}`, { method: 'PATCH', body: { title: 'Web title', notes: 'Web note', remind_at: record.data.remind_at } });
    const completedAt = '2026-10-03T11:00:00.000Z';
    const completion: SyncEntityMutation = { operationId: crypto.randomUUID(), entity: 'reminder', entityId: record.id, type: 'update', baseRevision: 1,
      base: { completed_at: null }, patch: { completed_at: completedAt } };
    const completed = await send(h, epoch, completion);
    assert.equal(completed.body.result.status, 'applied', JSON.stringify(completed.body));
    assert.equal(completed.body.result.record.data.title, 'Web title');
    assert.equal(completed.body.result.record.data.completed_at, completedAt);
    const conflict = await send(h, epoch, { ...completion, operationId: crypto.randomUUID(), base: { notes: 'Private reminder' }, patch: { notes: 'Phone note' } });
    assert.equal(conflict.body.result.status, 'conflict'); assert.equal(conflict.body.result.record.data.notes, 'Web note');
    assert.equal((await send(h, epoch, completion)).body.replayed, true);
    assert.equal((await h.call('reminders?status=completed')).body.reminders.length, 1);
  } finally { await h.close(); }
});

test('child writes enforce parent/workspace ownership, strict fields, cursor validity and recovery maintenance', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h); const other = await person(h, 'other');
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    for (const parent of [other.public_id, crypto.randomUUID()]) {
      const rejected = await send(h, epoch, create('reminder', parent));
      assert.equal(rejected.body.result.status, 'conflict'); assert.equal(rejected.body.result.record, null);
    }
    const mutation = create('interaction', contact.public_id);
    for (const patch of [{ date: '2026-02-30' }, { occurred_at: '2026-10-03T24:00:00Z' }, { occurred_at: '2026-10-04T10:00:00Z' }, { photo_url: 'https://invalid.test/' }, { type: 'unknown' }]) {
      assert.equal((await send(h, epoch, { ...mutation, data: { ...mutation.data, ...patch } })).status, 400);
    }
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM interactions').first())?.n, 0);
    assert.equal((await h.call(`v2/sync/pull?epoch=${epoch}&sequence=999999`)).status, 400);
    assert.equal((await h.call(`v2/sync/bootstrap?epoch=${epoch}`)).status, 400);
    await h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    assert.equal((await send(h, epoch, mutation)).status, 423);
    assert.equal((await h.call('v2/sync/bootstrap')).status, 423);
    assert.equal((await h.call(`v2/sync/pull?epoch=${epoch}&sequence=0`)).status, 423);
  } finally { await h.close(); }
});

test('deletion verifies recovery, keeps tombstones and journals cascaded history/reminders', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    const interaction = create('interaction', contact.public_id);
    const reminder = create('reminder', contact.public_id);
    const record = (await send(h, epoch, reminder)).body.result.record;
    await send(h, epoch, interaction);
    const deletion: SyncEntityMutation = { operationId: crypto.randomUUID(), entity: 'reminder', entityId: record.id, type: 'delete', baseRevision: record.revision };
    h.faults.failPut = true;
    assert.equal((await send(h, epoch, deletion)).status, 503);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM reminders').first())?.n, 1);
    h.faults.failPut = false;
    const deleted = await send(h, epoch, deletion);
    assert.equal(deleted.body.result.status, 'applied', JSON.stringify(deleted.body));
    assert.equal(deleted.body.result.record.deleted, true);
    assert.equal((await send(h, epoch, deletion)).body.replayed, true);
    assert.equal((await send(h, epoch, { ...reminder, operationId: crypto.randomUUID() })).body.result.status, 'conflict');
    const start = (await h.call('v2/sync/bootstrap')).body.cursor;
    await h.call(`contacts/${contact.id}`, { method: 'DELETE' });
    const response = (await h.call(`v2/sync/pull?epoch=${epoch}&sequence=${start.sequence}`)).body;
    readPullV2(response, start);
    const changes = response.changes;
    assert.ok(changes.some((c: { entity: string; record: { deleted: boolean } }) => c.entity === 'interaction' && c.record.deleted));
    assert.ok(changes.some((c: { entity: string; record: { deleted: boolean } }) => c.entity === 'contact' && c.record.deleted));
    assert.deepEqual((await h.call('v2/sync/bootstrap')).body.records, []);
  } finally { await h.close(); }
});

test('v2 client validation preserves offline state when entity identity, page position or dates are malformed', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const initial = (await h.call('v2/sync/bootstrap')).body.cursor;
    const mutation = create('reminder', contact.public_id);
    const response = await send(h, initial.epoch, mutation);
    const bootstrap = (await h.call('v2/sync/bootstrap')).body;
    assert.equal(readBootstrapV2(bootstrap).records.length, 2);
    for (const change of [
      (v: typeof bootstrap) => { v.records[1].data.contact_id = contact.id; },
      (v: typeof bootstrap) => { v.records[1].data.remind_at = '2026-02-30T10:00:00Z'; },
      (v: typeof bootstrap) => { v.records.reverse(); },
      (v: typeof bootstrap) => { v.entities.push('plan'); },
      (v: typeof bootstrap) => { v.next = { ...v.cursor, entity: 'contact', after: contact.public_id }; },
    ]) {
      const broken = structuredClone(bootstrap); change(broken);
      assert.throws(() => readBootstrapV2(broken), /invalid sync response/);
    }
    assert.throws(() => readPushResultV2(response.body, mutation.operationId, 'interaction', mutation.entityId), /invalid sync response/);
    const pull = (await h.call(`v2/sync/pull?epoch=${initial.epoch}&sequence=${initial.sequence}`)).body;
    assert.equal(readPullV2(pull, initial).records.length, 1);
    pull.changes[0].entity = 'interaction';
    assert.throws(() => readPullV2(pull, initial), /invalid sync response/);
  } finally { await h.close(); }
});

test('current recovery preserves all UUIDs and phone timestamps; old snapshots receive stable per-entity IDs and erasure removes replicas', async () => {
  const h = await createCloudHarness();
  try {
    const contact = await person(h);
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    await send(h, epoch, create('interaction', contact.public_id)); await send(h, epoch, create('reminder', contact.public_id));
    const records = (await h.call('v2/sync/bootstrap')).body.records;
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const original = (await h.call(`settings/backups/${backup.filename}`)).body;
    assert.equal(original.version, 14);
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    const restored = (await h.call('v2/sync/bootstrap')).body;
    assert.notEqual(restored.cursor.epoch, epoch); assert.equal(restored.cursor.sequence, 0);
    assert.deepEqual(restored.records.map((r: { id: string }) => r.id), records.map((r: { id: string }) => r.id));
    assert.equal(restored.records.find((r: { entity: string }) => r.entity === 'interaction').data.occurred_at, '2026-10-03T10:12:34.123Z');
    const legacy = structuredClone(original); legacy.version = 5; delete legacy.tables.contact_device_links;
    for (const table of ['interactions', 'reminders']) for (const row of legacy.tables[table]) delete row.public_id;
    delete legacy.tables.interactions[0].occurred_at;
    const validated = h.validateCloudSnapshot(legacy, 'test');
    assert.deepEqual(h.validateCloudSnapshot(legacy, 'test'), validated);
    assert.ok(isSyncUuid(validated.tables.interactions[0].public_id));
    assert.notEqual(validated.tables.interactions[0].public_id, validated.tables.reminders[0].public_id);
    assert.equal((await h.call('settings/restore', { method: 'POST', headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' }, body: legacy })).status, 200);
    assert.equal((await h.call(`v2/sync/pull?epoch=${epoch}&sequence=0`)).body.code, 'epoch_changed');
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    for (const table of ['sync_entity_records', 'sync_contact_records', 'sync_changes', 'sync_mutation_receipts']) {
      assert.equal((await h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = 'test'`).first())?.n, 0);
    }
  } finally { await h.close(); }
});

test('v2 contacts retain v1 idempotency across protocol upgrades and child operations cannot reuse their receipt', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('v2/sync/bootstrap')).body.cursor.epoch;
    const operationId = crypto.randomUUID(); const id = crypto.randomUUID();
    const legacy = await h.call('v1/sync/push', { method: 'POST', body: { version: 1, epoch, mutation: { operationId, contactId: id, type: 'create', data: { name: 'Ana' } } } });
    const upgraded = await send(h, epoch, { operationId, entity: 'contact', entityId: id, type: 'create', data: { name: 'Ana' } });
    assert.equal(upgraded.body.version, 2); assert.equal(upgraded.body.replayed, true);
    assert.deepEqual(upgraded.body.result.record, { ...legacy.body.result.record, entity: 'contact' });
    assert.equal((await send(h, epoch, { ...create('reminder', id), operationId })).status, 409);
  } finally { await h.close(); }
});
