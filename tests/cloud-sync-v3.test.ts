import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { isSyncUuid, type SyncCursor } from '../packages/domain/src/sync.ts';
import { SYNC_V3_ENTITIES, type SyncV3EntityMutation, type SyncV3EntityRecord } from '../packages/domain/src/sync-v3.ts';
import { readBootstrapV3, readPullV3, readPushResultV3, readSyncV3Record } from '../packages/domain/src/sync-v3-client.ts';
import { readBootstrapV2 } from '../packages/domain/src/sync-v2-client.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function person(h: Harness, name = 'Ana', workspace = 'test', extra = {}) {
  const response = await h.call('contacts', { method: 'POST', workspace, body: { name, ...extra } });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.contact;
}
async function send(h: Harness, epoch: string, mutation: SyncV3EntityMutation, workspace = 'test') {
  const response = await h.call('v3/sync/push', { method: 'POST', workspace, body: { version: 3, epoch, mutation } });
  if (response.status === 200) readPushResultV3(response.body, mutation.operationId, mutation.entity, mutation.entityId);
  return response;
}
function create(entity: 'plan' | 'family' | 'relationship', parent: string, related?: string): SyncV3EntityMutation & { type: 'create' } {
  return { operationId: crypto.randomUUID(), entity, entityId: crypto.randomUUID(), type: 'create', data: entity === 'plan'
    ? { contact_id: parent, type: 'meetup', planned_date: '2026-10-05', summary: 'Lunch', notes: 'Bring the book' }
    : entity === 'family' ? { contact_id: parent, name: 'Leo', birthday: '2020-02-29', linked_contact_id: related ?? null }
      : { contact_id: parent, related_contact_id: related, relationship_label: 'Friend', reciprocal_label: 'Friend' } };
}
async function bootstrap(h: Harness) {
  const records: SyncV3EntityRecord[] = [];
  let query = '', cursor!: SyncCursor;
  do {
    const response = await h.call(`v3/sync/bootstrap${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const page = readBootstrapV3(response.body); records.push(...page.records); cursor = page.cursor;
    query = page.next ? `?${new URLSearchParams(Object.entries(page.next).map(([k, v]) => [k, String(v)]))}` : '';
  } while (query);
  return { records, cursor };
}

test('plan/family/relationship migration preserves populated integer graphs and seeds UUID replicas without replay', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((s) => s.endsWith('.sql') && s < '0027_').sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('existing', 'Existing'); INSERT INTO contacts (id, workspace_id, name) VALUES (41, 'existing', 'Ana'), (42, 'existing', 'Leo'), (43, 'existing', 'Jo'); INSERT INTO plans (id, workspace_id, contact_id, type, planned_date) VALUES (42, 'existing', 41, 'meetup', '2026-10-05'), (43, 'existing', 41, 'call', '2026-10-06'); INSERT INTO contact_children (id, workspace_id, contact_id, linked_contact_id, name) VALUES (42, 'existing', 41, 42, 'Leo'), (43, 'existing', 41, NULL, 'May'); INSERT INTO contact_relationships (id, workspace_id, contact_id, related_contact_id, relationship_label, reciprocal_label) VALUES (42, 'existing', 41, 42, 'Parent', 'Child'), (43, 'existing', 41, 43, 'Friend', 'Friend');");
    const before = (db.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    db.exec(readFileSync(new URL('../drizzle/0027_plan_family_relationship_sync.sql', import.meta.url), 'utf8'));
    const ids: string[] = [];
    for (const table of ['plans', 'contact_children', 'contact_relationships']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<{ id: number; contact_id: number; public_id: string }>) {
        assert.equal(row.contact_id, 41); assert.ok(isSyncUuid(row.public_id)); ids.push(row.public_id);
        assert.throws(() => db.prepare(`UPDATE ${table} SET public_id = ? WHERE id = ?`).run(crypto.randomUUID(), row.id), /SYNC_IDENTITY_IMMUTABLE/);
      }
    }
    assert.equal(new Set(ids).size, 6);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n, before);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sync_entity_records WHERE revision = 1').get() as { n: number }).n, 6);
    const linked = JSON.parse((db.prepare("SELECT payload FROM sync_entity_records WHERE entity_type = 'family' AND legacy_id = 42").get() as { payload: string }).payload);
    assert.equal(linked.linked_contact_id, (db.prepare('SELECT public_id FROM contacts WHERE id = 42').get() as { public_id: string }).public_id);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally { db.close(); }
});

test('v3 bounded bootstrap and journal include ordinary web plans/family/relationships while older protocols stay compatible', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), linked = await person(h, 'Leo', 'test', { birthday: '2020-02-29' });
    const start = (await h.call('v3/sync/bootstrap')).body.cursor;
    for (let i = 0; i < 6; i++) {
      assert.equal((await h.call('plans', { method: 'POST', body: { contact_id: parent.id, type: 'meetup', planned_date: '2026-10-05' } })).status, 201);
      assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: { name: `Child ${i}` } })).status, 201);
    }
    const family = (await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: { name: 'Leo', birthday: linked.birthday, linked_contact_id: linked.id } })).body.child;
    assert.equal((await h.call(`contacts/${parent.id}/relationships`, { method: 'POST', body: { related_contact_id: linked.id, relationship_label: 'Child', reciprocal_label: 'Parent' } })).status, 201);
    const first = await h.call('v3/sync/bootstrap'); assert.equal(first.body.records.length, 10); assert.ok(first.body.next);
    assert.deepEqual(first.body.entities, SYNC_V3_ENTITIES);
    const all = await bootstrap(h); assert.equal(all.records.length, 16);
    assert.ok(all.records.slice(0, 2).every((r) => r.entity === 'contact'));
    for (const r of all.records.slice(2)) assert.equal(r.data!.contact_id, parent.public_id);
    const legacy = await h.call('v2/sync/bootstrap'); readBootstrapV2(legacy.body); assert.equal(legacy.body.records.length, 2);
    for (const version of [1, 2]) {
      const pull = await h.call(`v${version}/sync/pull?epoch=${start.epoch}&sequence=${start.sequence}`);
      assert.deepEqual(pull.body.changes, []); assert.equal(pull.body.cursor.sequence, all.cursor.sequence);
    }
    await h.call(`contacts/${linked.id}`, { method: 'DELETE' });
    const changed = await bootstrap(h);
    const unlinked = changed.records.find((r) => r.entity === 'family' && r.legacyId === family.id)!;
    assert.equal(unlinked.data!.linked_contact_id, null); assert.equal(unlinked.data!.name, 'Leo'); assert.equal(unlinked.data!.birthday, linked.birthday);
    assert.ok(unlinked.revision > 1); assert.equal(changed.records.some((r) => r.entity === 'relationship'), false);
    assert.equal((await h.call(`v3/sync/bootstrap?${new URLSearchParams(first.body.next)}`)).body.code, 'bootstrap_changed');
    let cursor = start; const seen = [];
    do {
      const response = await h.call(`v3/sync/pull?epoch=${cursor.epoch}&sequence=${cursor.sequence}`);
      const page = readPullV3(response.body, cursor); seen.push(...page.records); cursor = page.cursor;
      if (!page.more) break;
    } while (true);
    assert.ok(seen.some((r) => r.entity === 'relationship' && r.deleted));
    assert.equal(cursor.sequence, changed.cursor.sequence);
  } finally { await h.close(); }
});

test('plan completion commits one history record with its receipt across concurrent retries and later completion attempts', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), epoch = (await bootstrap(h)).cursor.epoch;
    const draft = create('plan', parent.public_id), created = await send(h, epoch, draft);
    assert.equal(created.body.result.status, 'applied'); const record = created.body.result.record;
    await h.call(`plans/${record.legacyId}`, { method: 'PATCH', body: { notes: 'Web note' } });
    const completion: SyncV3EntityMutation = { operationId: crypto.randomUUID(), entity: 'plan', entityId: record.id, type: 'update', baseRevision: 1,
      base: { completed_at: null }, patch: { completed_at: '2026-10-03T12:30:00+01:00' } };
    const results = await Promise.all([send(h, epoch, completion), send(h, epoch, completion)]);
    assert.deepEqual(results[0].body.result, results[1].body.result);
    assert.equal(results.filter((r) => r.body.replayed).length, 1);
    assert.equal(results[0].body.result.record.data.completed_at, '2026-10-03T11:30:00.000Z');
    assert.equal(results[0].body.result.record.data.notes, 'Web note');
    const history = (await h.db.prepare('SELECT * FROM interactions WHERE contact_id = ?').bind(parent.id).all()).results;
    assert.equal(history.length, 1); assert.equal(history[0].public_id, completion.operationId); assert.equal(history[0].notes, 'Web note'); assert.equal(history[0].occurred_at, '2026-10-03T11:30:00.000Z');
    assert.equal((await send(h, epoch, { ...completion, operationId: crypto.randomUUID(), baseRevision: results[0].body.result.record.revision })).body.result.status, 'conflict');
    assert.equal((await h.call(`plans/${record.legacyId}`, { method: 'PATCH', body: { completed: true } })).body.interactionCreated, false);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM interactions').first())?.n, 1);
    const historical = create('plan', parent.public_id); historical.data.completed_at = '2026-10-03T11:30:00Z';
    const preserved = await send(h, epoch, historical); assert.equal(preserved.body.result.status, 'applied');
    assert.equal(preserved.body.result.record.data.completed_at, '2026-10-03T11:30:00.000Z');
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM interactions').first())?.n, 1, 'preserving completed metadata never logs a second activity');
    assert.equal((await send(h, epoch, { ...completion, operationId: crypto.randomUUID(), patch: { completed_at: null } })).status, 400);
    const replay = await send(h, epoch, completion); assert.deepEqual(replay.body.result, results[0].body.result);
    const replica = await bootstrap(h); assert.equal(replica.records.filter((r) => r.entity === 'interaction').length, 1);
    const another = (await send(h, epoch, create('plan', parent.public_id))).body.result.record;
    const occupiedId = crypto.randomUUID();
    await h.db.prepare("INSERT INTO interactions (public_id, workspace_id, contact_id, type, date) VALUES (?, 'test', ?, 'call', '2026-10-02')").bind(occupiedId, parent.id).run();
    const occupied = await send(h, epoch, { ...completion, operationId: occupiedId, entityId: another.id });
    assert.equal(occupied.body.result.status, 'conflict');
    assert.equal((await h.db.prepare('SELECT completed_at FROM plans WHERE id = ?').bind(another.legacyId).first())?.completed_at, null);
    await h.db.prepare('DELETE FROM interactions WHERE public_id = ?').bind(occupiedId).run();
    assert.equal((await send(h, epoch, { ...completion, operationId: occupiedId, entityId: another.id })).body.replayed, true);
    // A tombstoned history identity also cannot be resurrected by another plan's completion.
    const tombstonedId = crypto.randomUUID();
    await h.db.prepare("INSERT INTO interactions (public_id, workspace_id, contact_id, type, date) VALUES (?, 'test', ?, 'call', '2026-10-02')").bind(tombstonedId, parent.id).run();
    await h.db.prepare('DELETE FROM interactions WHERE public_id = ?').bind(tombstonedId).run();
    const tombstoned = await send(h, epoch, { ...completion, operationId: tombstonedId, entityId: another.id });
    assert.equal(tombstoned.body.result.status, 'conflict');
    const retry: SyncV3EntityMutation = { ...completion, operationId: crypto.randomUUID(), entityId: another.id };
    await h.db.prepare("CREATE TRIGGER test_plan_log_failure BEFORE INSERT ON interactions BEGIN SELECT RAISE(ABORT, 'TEST_HISTORY_FAILURE'); END").run();
    assert.equal((await send(h, epoch, retry)).status, 503);
    assert.equal((await h.db.prepare('SELECT completed_at FROM plans WHERE id = ?').bind(another.legacyId).first())?.completed_at, null);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM sync_mutation_receipts WHERE operation_id = ?').bind(retry.operationId).first())?.n, 0);
    await h.db.prepare('DROP TRIGGER test_plan_log_failure').run();
    assert.equal((await send(h, epoch, retry)).body.result.status, 'applied');
    assert.equal((await send(h, epoch, retry)).body.replayed, true);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM interactions').first())?.n, 2);
  } finally { await h.close(); }
});

test('family links reject unavailable/self/duplicate/birthday-mismatched profiles and preserve disjoint edits and original bases', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), linked = await person(h, 'Leo', 'test', { birthday: '2020-02-29' }), foreign = await person(h, 'Foreign', 'other');
    const epoch = (await bootstrap(h)).cursor.epoch;
    for (const id of [parent.public_id, foreign.public_id, crypto.randomUUID()]) assert.equal((await send(h, epoch, create('family', parent.public_id, id))).body.result.status, 'conflict');
    const mismatch = create('family', parent.public_id, linked.public_id); mismatch.data.birthday = '2020-03-01';
    assert.equal((await send(h, epoch, mismatch)).body.result.status, 'conflict');
    const draft = create('family', parent.public_id, linked.public_id), created = await send(h, epoch, draft), record = created.body.result.record;
    assert.equal(created.body.result.status, 'applied'); assert.equal(record.data.linked_contact_id, linked.public_id);
    assert.equal((await send(h, epoch, create('family', parent.public_id, linked.public_id))).body.result.status, 'conflict');
    const web = (await h.db.prepare('SELECT * FROM contact_children WHERE id = ?').bind(record.legacyId).first())!;
    assert.equal((await h.call(`contacts/${parent.id}/children/${record.legacyId}`, { method: 'PATCH', body: { name: 'Web name', birthday: web.birthday,
      linked_contact_id: linked.id, expected_updated_at: web.updated_at } })).status, 200);
    const unlink: SyncV3EntityMutation = { operationId: crypto.randomUUID(), entity: 'family', entityId: record.id, type: 'update', baseRevision: 1,
      base: { linked_contact_id: linked.public_id }, patch: { linked_contact_id: null } };
    const result = await send(h, epoch, unlink); assert.equal(result.body.result.status, 'applied'); assert.equal(result.body.result.record.data.name, 'Web name');
    const conflict = await send(h, epoch, { ...unlink, operationId: crypto.randomUUID(), base: { name: 'Leo' }, patch: { name: 'Phone name' } });
    assert.equal(conflict.body.result.status, 'conflict'); assert.equal(conflict.body.result.record.data.name, 'Web name');
    assert.equal((await send(h, epoch, unlink)).body.replayed, true);
    const badLink = { ...unlink, operationId: crypto.randomUUID(), baseRevision: result.body.result.record.revision,
      base: { linked_contact_id: null }, patch: { linked_contact_id: foreign.public_id } };
    assert.equal((await send(h, epoch, badLink)).body.result.status, 'conflict');
    const relink = { ...badLink, operationId: crypto.randomUUID(), base: { linked_contact_id: null, birthday: '2020-02-29' },
      patch: { linked_contact_id: linked.public_id, birthday: '2020-03-01' } };
    assert.equal((await send(h, epoch, relink)).body.result.status, 'conflict');
    const matched = await send(h, epoch, { ...relink, operationId: crypto.randomUUID(), patch: { linked_contact_id: linked.public_id, birthday: '2020-02-29' } });
    assert.equal(matched.body.result.status, 'applied'); assert.equal(matched.body.result.record.data.linked_contact_id, linked.public_id);
    const unlinkedDraft = create('family', parent.public_id), unlinked = (await send(h, epoch, unlinkedDraft)).body.result.record;
    assert.equal((await send(h, epoch, { operationId: crypto.randomUUID(), entity: 'family', entityId: unlinked.id, type: 'update', baseRevision: 1,
      base: { linked_contact_id: null }, patch: { linked_contact_id: linked.public_id } })).body.result.status, 'conflict');
    assert.equal((await send(h, epoch, { ...unlink, operationId: crypto.randomUUID(), patch: { contact_id: linked.public_id }, base: { contact_id: parent.public_id } })).status, 400);
    const malformed = create('family', parent.public_id); malformed.data.name = 'Bad\u0000name';
    assert.equal((await send(h, epoch, malformed)).status, 400);
  } finally { await h.close(); }
});

test('relationships stay one shared pair with both labels and recoverable deletion, never crossing a workspace', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), related = await person(h, 'Jo'), foreign = await person(h, 'Foreign', 'other');
    const epoch = (await bootstrap(h)).cursor.epoch;
    for (const id of [parent.public_id, foreign.public_id, crypto.randomUUID()]) assert.equal((await send(h, epoch, create('relationship', parent.public_id, id))).body.result.status, 'conflict');
    const draft = create('relationship', parent.public_id, related.public_id); draft.data.relationship_label = 'Mentor'; draft.data.reciprocal_label = 'Mentee';
    const created = await send(h, epoch, draft), record = created.body.result.record; assert.equal(created.body.result.status, 'applied');
    assert.equal((await send(h, epoch, create('relationship', related.public_id, parent.public_id))).body.result.status, 'conflict');
    const parentView = (await h.call(`contacts/${parent.id}/relationships`)).body.relationships[0];
    const relatedView = (await h.call(`contacts/${related.id}/relationships`)).body.relationships[0];
    assert.equal(parentView.relationship_label, 'Mentor'); assert.equal(relatedView.relationship_label, 'Mentee'); assert.equal(parentView.id, relatedView.id);
    const edit: SyncV3EntityMutation = { operationId: crypto.randomUUID(), entity: 'relationship', entityId: record.id, type: 'update', baseRevision: 1,
      base: { relationship_label: 'Mentor' }, patch: { relationship_label: 'Friend' } };
    const edited = await send(h, epoch, edit); assert.equal(edited.body.result.status, 'applied');
    assert.equal((await send(h, epoch, { ...edit, operationId: crypto.randomUUID(), patch: { relationship_label: 'Other' } })).body.result.status, 'conflict');
    const reciprocal = await send(h, epoch, { ...edit, operationId: crypto.randomUUID(), base: { reciprocal_label: 'Mentee' }, patch: { reciprocal_label: 'Peer' } });
    assert.equal(reciprocal.body.result.status, 'applied'); assert.equal(reciprocal.body.result.record.data.relationship_label, 'Friend');
    const deletion: SyncV3EntityMutation = { operationId: crypto.randomUUID(), entity: 'relationship', entityId: record.id, type: 'delete', baseRevision: reciprocal.body.result.record.revision };
    h.faults.failPut = true; assert.equal((await send(h, epoch, deletion)).status, 503); h.faults.failPut = false;
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM contact_relationships').first())?.n, 1);
    const removed = await send(h, epoch, deletion); assert.equal(removed.body.result.status, 'applied'); assert.equal(removed.body.result.record.deleted, true);
    assert.equal((await send(h, epoch, deletion)).body.replayed, true);
    assert.equal((await send(h, epoch, { ...draft, operationId: crypto.randomUUID() })).body.result.status, 'conflict');
    assert.equal((await h.call('settings/backups')).body.backups.filter((b: { reason: string }) => b.reason === 'pre-delete').length, 1);
  } finally { await h.close(); }
});

test('current recovery preserves all entity identities, legacy v6 assigns stable namespaced IDs, and erasure removes transport state', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), related = await person(h, 'Leo', 'test', { birthday: '2020-02-29' }), epoch = (await bootstrap(h)).cursor.epoch;
    for (const entity of ['plan', 'family', 'relationship'] as const) assert.equal((await send(h, epoch, create(entity, parent.public_id, related.public_id))).body.result.status, 'applied');
    const original = await bootstrap(h), backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await h.call(`settings/backups/${backup.filename}`)).body; assert.equal(snapshot.version, 14);
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    const restored = await bootstrap(h); assert.notEqual(restored.cursor.epoch, epoch); assert.equal(restored.cursor.sequence, 0);
    assert.deepEqual(restored.records.map((r) => r.id), original.records.map((r) => r.id));
    const legacy = structuredClone(snapshot); legacy.version = 6; delete legacy.tables.contact_device_links;
    for (const table of ['plans', 'contact_children', 'contact_relationships']) for (const row of legacy.tables[table]) delete row.public_id;
    const validated = h.validateCloudSnapshot(legacy, 'test'); assert.deepEqual(h.validateCloudSnapshot(legacy, 'test'), validated);
    const ids = ['plans', 'contact_children', 'contact_relationships'].map((table) => validated.tables[table][0].public_id);
    assert.equal(new Set(ids).size, 3); assert.ok(ids.every(isSyncUuid));
    assert.equal((await h.call('settings/restore', { method: 'POST', headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' }, body: legacy })).status, 200);
    const legacyReplica = await bootstrap(h); assert.equal(legacyReplica.records.length, 5); assert.equal(legacyReplica.cursor.sequence, 0);
    assert.deepEqual(legacyReplica.records.filter((r) => r.entity !== 'contact').map((r) => r.id).sort(), ids.sort());
    assert.equal((await h.call(`v3/sync/pull?epoch=${epoch}&sequence=0`)).body.code, 'epoch_changed');
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    for (const table of ['sync_entity_records', 'sync_contact_records', 'sync_changes', 'sync_mutation_receipts']) assert.equal((await h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = 'test'`).first())?.n, 0);
  } finally { await h.close(); }
});

test('v3 transports reject malformed identities, dates and acknowledgements and share existing receipts across protocol versions', async () => {
  const h = await createCloudHarness();
  try {
    const parent = await person(h), epoch = (await bootstrap(h)).cursor.epoch;
    const created = await send(h, epoch, create('plan', parent.public_id)), record = created.body.result.record;
    for (const data of [{ ...record.data, contact_id: 1 }, { ...record.data, planned_date: '2026-02-30' }, { ...record.data, completed_at: 'yesterday' }]) assert.throws(() => readSyncV3Record({ ...record, data }));
    assert.throws(() => readPushResultV3(created.body, crypto.randomUUID(), 'plan', record.id));
    assert.throws(() => readPushResultV3(created.body, created.body.result.operationId, 'family', record.id));
    const page = (await h.call('v3/sync/bootstrap')).body;
    assert.throws(() => readBootstrapV3({ ...page, entities: ['contact'] }));
    assert.equal((await h.call('v2/sync/push', { method: 'POST', body: { version: 2, epoch, mutation: create('plan', parent.public_id) } })).status, 400);
    const mutation = { operationId: crypto.randomUUID(), entity: 'reminder' as const, entityId: crypto.randomUUID(), type: 'create' as const,
      data: { contact_id: parent.public_id, title: 'Call back', remind_at: '2026-10-05T10:00:00Z' } };
    const v2 = await h.call('v2/sync/push', { method: 'POST', body: { version: 2, epoch, mutation } });
    const v3 = await send(h, epoch, mutation); assert.equal(v3.body.replayed, true); assert.deepEqual(v3.body.result, v2.body.result);
    const reused = create('plan', parent.public_id); reused.operationId = mutation.operationId; assert.equal((await send(h, epoch, reused)).status, 409);
    const unavailable = (await h.call('v3/sync/bootstrap', { workspace: 'other' })).body.cursor.epoch;
    assert.equal((await send(h, unavailable, create('plan', parent.public_id), 'other')).body.result.status, 'conflict');
    await h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    assert.equal((await h.call('v3/sync/bootstrap')).status, 423); assert.equal((await send(h, epoch, create('plan', parent.public_id))).status, 423);
  } finally { await h.close(); }
});

test('web merges publish new parent and linked-profile references without changing plan/family/relationship identities', async () => {
  const h = await createCloudHarness();
  try {
    const primary = await person(h, 'Ana', 'test', { email: 'ana@example.test' });
    const duplicate = await person(h, 'Ana Duplicate', 'test', { email: 'ana@example.test' });
    const leo = await person(h, 'Leo', 'test', { birthday: '2020-02-29' }), jo = await person(h, 'Jo');
    const epoch = (await bootstrap(h)).cursor.epoch;
    const records = [];
    for (const entity of ['plan', 'family', 'relationship'] as const) {
      const result = await send(h, epoch, create(entity, duplicate.public_id, entity === 'family' ? leo.public_id : jo.public_id));
      assert.equal(result.body.result.status, 'applied'); records.push(result.body.result.record);
    }
    const link = create('family', jo.public_id, duplicate.public_id); link.data.birthday = null;
    const incoming = await send(h, epoch, link); assert.equal(incoming.body.result.status, 'applied');
    const review = await h.call('contacts/duplicates'); assert.equal(review.status, 200);
    const merged = await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary.id, duplicateIds: [duplicate.id], expectedRevision: review.body.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const replica = await bootstrap(h);
    for (const previous of records) {
      const current = replica.records.find((r) => r.id === previous.id && r.entity === previous.entity)!;
      assert.ok(current); assert.equal(current.data!.contact_id, primary.public_id); assert.ok(current.revision > previous.revision);
    }
    assert.equal(replica.records.find((r) => r.id === incoming.body.result.record.id)!.data!.linked_contact_id, primary.public_id);
    const plan = records.find((r) => r.entity === 'plan');
    const edited = await send(h, epoch, { operationId: crypto.randomUUID(), entity: 'plan', entityId: plan.id, type: 'update', baseRevision: 1,
      base: { notes: plan.data.notes }, patch: { notes: 'Retained phone edit' } });
    assert.equal(edited.body.result.status, 'applied'); assert.equal(edited.body.result.record.data.contact_id, primary.public_id);
    assert.equal((await h.call(`contacts/${primary.id}`, { method: 'DELETE' })).status, 200);
    for (const previous of records) {
      const tombstone = await h.db.prepare('SELECT payload, deleted_at FROM sync_entity_records WHERE entity_type = ? AND public_id = ?').bind(previous.entity, previous.id).first();
      assert.equal(tombstone?.payload, null); assert.ok(tombstone?.deleted_at);
    }
    const retained = (await bootstrap(h)).records.find((r) => r.id === incoming.body.result.record.id)!;
    assert.equal(retained.data!.linked_contact_id, null);
  } finally { await h.close(); }
});
