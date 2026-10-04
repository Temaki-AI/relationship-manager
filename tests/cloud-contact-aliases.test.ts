import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { readPushResult, readSyncRecord } from '../packages/domain/src/sync-client.ts';
import { readPushResultV2 } from '../packages/domain/src/sync-v2-client.ts';
import { readPushResultV3 } from '../packages/domain/src/sync-v3-client.ts';
import { readContactMergeAliases } from '../packages/domain/src/contact-aliases.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function person(h: Harness, name: string, workspace = 'test') {
  const result = await h.call('contacts', { method: 'POST', workspace, body: { name, email: 'ana@example.test' } });
  assert.equal(result.status, 201); return result.body.contact;
}
async function merge(h: Harness, primary: number, duplicates: number[]) {
  const review = await h.call('contacts/duplicates');
  return h.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary, duplicateIds: duplicates, expectedRevision: review.body.revision } });
}
async function send(h: Harness, epoch: string, contactId: string, baseRevision: number, field: string, original: string | null, value: string, operationId = crypto.randomUUID()) {
  const response = await h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch,
    mutation: { operationId, entity: 'contact', entityId: contactId, type: 'update', baseRevision, base: { [field]: original }, patch: { [field]: value } } } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  readPushResultV3(response.body, operationId, 'contact', contactId); return response;
}

test('alias migration preserves existing integer/public identities and adds default aliases without replaying history', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((s) => s.endsWith('.sql') && s < '0028_').sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('existing', 'Existing'); INSERT INTO contacts (id, workspace_id, name) VALUES (41, 'existing', 'Ana')");
    const before = db.prepare('SELECT public_id FROM contacts').get() as { public_id: string };
    const changes = db.prepare('SELECT count(*) n FROM sync_changes').get() as { n: number };
    db.exec(readFileSync(new URL('../drizzle/0028_contact_merge_aliases.sql', import.meta.url), 'utf8'));
    assert.deepEqual(db.prepare('SELECT id, public_id, merge_aliases FROM contacts').get(), { id: 41, public_id: before.public_id, merge_aliases: '[]' });
    assert.equal((db.prepare('SELECT count(*) n FROM sync_changes').get() as { n: number }).n, changes.n);
    assert.equal(JSON.parse((db.prepare('SELECT payload FROM sync_contact_records').get() as { payload: string }).payload).merge_aliases, '[]');
    const alias = crypto.randomUUID(); db.prepare('UPDATE contacts SET merge_aliases = ? WHERE id = 41').run(JSON.stringify([alias]));
    assert.equal((db.prepare('SELECT canonical_public_id FROM contact_merge_aliases').get() as { canonical_public_id: string }).canonical_public_id, before.public_id);
    assert.throws(() => db.prepare("UPDATE contacts SET merge_aliases = '[]' WHERE id = 41").run(), /CLOUD_CONTACT_ALIAS_IMMUTABLE/);
    assert.throws(() => db.prepare('INSERT INTO contacts (public_id, workspace_id, name) VALUES (?, ?, ?)').run(alias, 'existing', 'Resurrected'), /CLOUD_CONTACT_ALIAS_IMMUTABLE/);
    for (const invalid of ['{}', 'invalid', '["invalid"]', JSON.stringify([alias, alias]), JSON.stringify([before.public_id])]) assert.throws(() => db.prepare('UPDATE contacts SET merge_aliases = ? WHERE id = 41').run(invalid), /CLOUD_CONTACT_ALIAS_INVALID/);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally { db.close(); }
});

test('chained cloud merges flatten aliases and safe original-value updates reach the final survivor with exact receipts', async () => {
  const h = await createCloudHarness();
  try {
    const a = await person(h, 'Ana'), b = await person(h, 'Ana duplicate'), c = await person(h, 'Ana final');
    const start = (await h.call('v3/sync/bootstrap')).body.cursor;
    assert.equal((await merge(h, a.id, [b.id])).status, 200);
    assert.equal((await merge(h, c.id, [a.id])).status, 200);
    const aliases = (await h.db.prepare('SELECT public_id, canonical_public_id FROM contact_merge_aliases ORDER BY public_id').all()).results;
    assert.deepEqual(aliases.map((row) => row.public_id), [a.public_id, b.public_id].sort());
    assert.ok(aliases.every((row) => row.canonical_public_id === c.public_id));
    const survivor = (await h.call('v3/sync/bootstrap')).body.records[0];
    assert.deepEqual(readContactMergeAliases(survivor.data.merge_aliases, survivor.id), [a.public_id, b.public_id].sort());
    const op = crypto.randomUUID();
    const applied = await send(h, start.epoch, b.public_id, 1, 'phone', null, '+351 910 000 001', op);
    assert.equal(applied.body.result.status, 'applied'); assert.equal(applied.body.result.record.id, b.public_id);
    assert.equal(applied.body.result.record.deleted, true); assert.equal(applied.body.result.record.mergedIntoId, c.public_id);
    assert.equal(applied.body.result.canonicalRecord.id, c.public_id); assert.equal(applied.body.result.canonicalRecord.data.phone, '+351 910 000 001');
    const replay = await send(h, start.epoch, b.public_id, 1, 'phone', null, '+351 910 000 001', op);
    assert.deepEqual(replay.body.result, applied.body.result); assert.equal(replay.body.replayed, true);
    const source = { operationId: op, contactId: b.public_id, type: 'update', baseRevision: 1, base: { phone: null }, patch: { phone: '+351 910 000 001' } };
    const v1 = await h.call('v1/sync/push', { method: 'POST', body: { version: 1, epoch: start.epoch, mutation: source } });
    readPushResult(v1.body, op, b.public_id); assert.equal(v1.body.replayed, true);
    const { contactId, ...rest } = source;
    const v2 = await h.call('v2/sync/push', { method: 'POST', body: { version: 2, epoch: start.epoch, mutation: { ...rest, entity: 'contact', entityId: contactId } } });
    readPushResultV2(v2.body, op, 'contact', b.public_id); assert.equal(v2.body.replayed, true);
    const pull = await h.call(`v3/sync/pull?epoch=${start.epoch}&sequence=${start.sequence}`);
    const tombstones = pull.body.changes.filter((change: { record: { deleted: boolean } }) => change.record.deleted);
    assert.equal(tombstones.length, 2); assert.ok(tombstones.every((change: { record: { mergedIntoId: string } }) => change.record.mergedIntoId === c.public_id));
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contacts').first())?.n, 1);
  } finally { await h.close(); }
});

test('merged contact updates always compare original fields, while stale delete/create requests never delete or revive the survivor', async () => {
  const h = await createCloudHarness();
  try {
    const a = await person(h, 'Ana'), b = await person(h, 'Ana duplicate'), foreign = await person(h, 'Foreign', 'other');
    const epoch = (await h.call('v3/sync/bootstrap')).body.cursor.epoch;
    assert.equal((await merge(h, a.id, [b.id])).status, 200);
    await h.db.prepare("UPDATE contacts SET phone = '+351 910 000 002' WHERE id = ?").bind(a.id).run();
    const conflict = await send(h, epoch, b.public_id, 1, 'phone', null, '+351 910 000 003');
    assert.equal(conflict.body.result.status, 'conflict'); assert.equal(conflict.body.result.canonicalRecord.data.phone, '+351 910 000 002');
    const old = await h.db.prepare('SELECT revision FROM sync_contact_records WHERE workspace_id = ? AND public_id = ?').bind('test', b.public_id).first();
    const remove = await h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch, mutation: { operationId: crypto.randomUUID(), entity: 'contact', entityId: b.public_id, type: 'delete', baseRevision: old!.revision } } });
    assert.equal(remove.body.result.status, 'conflict'); assert.equal(remove.body.result.canonicalRecord.id, a.public_id);
    const create = await h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch, mutation: { operationId: crypto.randomUUID(), entity: 'contact', entityId: b.public_id, type: 'create', data: { name: 'Recreated duplicate' } } } });
    assert.equal(create.body.result.status, 'conflict');
    assert.equal((await send(h, epoch, foreign.public_id, 1, 'phone', null, '+351 910 000 004')).body.result.record, null);
    assert.equal((await h.db.prepare('SELECT phone FROM contacts WHERE id = ?').bind(a.id).first())?.phone, '+351 910 000 002');
    await h.call(`contacts/${a.id}`, { method: 'DELETE' });
    const gone = await send(h, epoch, b.public_id, 1, 'phone', null, '+351 910 000 005');
    assert.equal(gone.body.result.status, 'conflict'); assert.equal(gone.body.result.canonicalRecord.deleted, true);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM contacts WHERE workspace_id = 'test'").first())?.n, 0);
  } finally { await h.close(); }
});

test('frozen child creates resolve merged references without changing fingerprints or creating duplicate and self pairs', async () => {
  const h = await createCloudHarness();
  try {
    const a = await person(h, 'Ana'), b = await person(h, 'Ana duplicate'), other = await person(h, 'Jo');
    const epoch = (await h.call('v3/sync/bootstrap')).body.cursor.epoch;
    assert.equal((await merge(h, a.id, [b.id])).status, 200);
    for (const entity of ['interaction', 'reminder', 'plan', 'family', 'relationship']) {
      const data = entity === 'interaction' ? { date: '2026-10-03', occurred_at: null, type: 'call', summary: 'Call', notes: null }
        : entity === 'reminder' ? { title: 'Call soon', remind_at: '2030-01-01T10:00:00Z' }
          : entity === 'plan' ? { type: 'meetup', planned_date: '2026-10-05', summary: 'Lunch' }
            : entity === 'family' ? { name: 'Jo', linked_contact_id: other.public_id }
              : { related_contact_id: other.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' };
      const body = { version: 3, epoch, mutation: { operationId: crypto.randomUUID(), entity, entityId: crypto.randomUUID(), type: 'create', data: { contact_id: b.public_id, ...data } } };
      const first = await h.call('v3/sync/push', { method: 'POST', body });
      assert.equal(first.body.result.status, 'applied', JSON.stringify(first.body)); assert.equal(first.body.result.record.data.contact_id, a.public_id);
      const second = await h.call('v3/sync/push', { method: 'POST', body }); assert.deepEqual(second.body.result, first.body.result); assert.equal(second.body.replayed, true);
    }
    const self = await h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch, mutation: { operationId: crypto.randomUUID(), entity: 'relationship', entityId: crypto.randomUUID(), type: 'create', data: { contact_id: a.public_id, related_contact_id: b.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' } } } });
    assert.equal(self.body.result.status, 'conflict');
    const duplicate = await h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch, mutation: { operationId: crypto.randomUUID(), entity: 'relationship', entityId: crypto.randomUUID(), type: 'create', data: { contact_id: other.public_id, related_contact_id: b.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' } } } });
    assert.equal(duplicate.body.result.status, 'conflict');
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_relationships').first())?.n, 1);
  } finally { await h.close(); }
});

test('alias assignment is inside the protected merge transaction and an index failure rolls back the entire merge', async () => {
  const h = await createCloudHarness();
  try {
    const a = await person(h, 'Ana'), b = await person(h, 'Ana duplicate');
    await h.db.prepare("CREATE TRIGGER test_alias_failure BEFORE INSERT ON contact_merge_aliases BEGIN SELECT RAISE(ABORT, 'TEST_ALIAS_FAILURE'); END").run();
    assert.equal((await merge(h, a.id, [b.id])).status, 503);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contacts').first())?.n, 2);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_merge_aliases').first())?.n, 0);
    assert.equal((await h.db.prepare('SELECT merge_aliases FROM contacts WHERE id = ?').bind(a.id).first())?.merge_aliases, '[]');
    await h.db.prepare('DROP TRIGGER test_alias_failure').run();
    assert.equal((await merge(h, a.id, [b.id])).status, 200);
  } finally { await h.close(); }
});

test('snapshot v8 preserves authoritative aliases and recovery rebuilds the index; restoring v7 clears absent aliases and erasure clears transport', async () => {
  const h = await createCloudHarness();
  try {
    const a = await person(h, 'Ana'), b = await person(h, 'Ana duplicate');
    assert.equal((await merge(h, a.id, [b.id])).status, 200);
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await h.call(`settings/backups/${backup.filename}`)).body; assert.equal(snapshot.version, 14);
    assert.equal(snapshot.tables.contacts[0].merge_aliases, JSON.stringify([b.public_id]));
    assert.equal(snapshot.tables.contact_merge_aliases, undefined, 'the lookup index is derived, while the authoritative aliases are backed up');
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    assert.equal((await h.db.prepare('SELECT canonical_public_id FROM contact_merge_aliases WHERE public_id = ?').bind(b.public_id).first())?.canonical_public_id, a.public_id);
    const legacy = structuredClone(snapshot); legacy.version = 7; delete legacy.tables.contact_device_links; delete legacy.tables.contacts[0].merge_aliases; delete legacy.tables.contacts[0].contact_methods;
    const restored = await h.call('settings/restore', { method: 'POST', headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' }, body: legacy });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_merge_aliases').first())?.n, 0);
    assert.equal((await h.db.prepare('SELECT merge_aliases FROM contacts').first())?.merge_aliases, '[]');
    const epoch = (await h.call('v3/sync/bootstrap')).body.cursor.epoch;
    assert.equal((await send(h, epoch, b.public_id, 1, 'phone', null, '+351 910 000 006')).body.result.status, 'conflict');
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_merge_aliases').first())?.n, 0);
  } finally { await h.close(); }
});

test('strict contact readers reject ambiguous, self and malformed alias identities and forged canonical acknowledgements', () => {
  const id = crypto.randomUUID(), alias = crypto.randomUUID();
  for (const value of [null, '{}', 'invalid', JSON.stringify([id]), JSON.stringify([alias, alias]), JSON.stringify(['invalid'])]) assert.throws(() => readContactMergeAliases(value, id));
  const tombstone = { id: alias, legacyId: 1, revision: 2, deleted: true, data: null, mergedIntoId: id };
  assert.equal(readSyncRecord(tombstone).mergedIntoId, id);
  assert.throws(() => readSyncRecord({ ...tombstone, mergedIntoId: alias }));
  assert.throws(() => readSyncRecord({ ...tombstone, mergedIntoId: 'invalid' }));
  assert.throws(() => readPushResult({ version: 1, replayed: false, result: { operationId: id, status: 'conflict', record: tombstone, canonicalRecord: { ...tombstone, id: crypto.randomUUID() } } }, id, alias));
});
