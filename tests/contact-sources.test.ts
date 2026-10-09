import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { createLinkedInSource, changeContactSource, listContactSources } from '../lib/contact-source-storage.ts';
import { getContactEditRevision } from '../lib/contact-revision.ts';
import { mergeContacts } from '../lib/contact-merge.ts';
import { linkedinProfileIdentity, normalizeSourceObservations, observeSourceFacts, readContactSources, readSourceFacts } from '../packages/domain/src/contact-sources.ts';
import { readSyncRecord } from '../packages/domain/src/sync-client.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('source identity rejects unsafe and ambiguous URLs; observations retain originals including explicit missing values', () => {
  assert.equal(linkedinProfileIdentity('linkedin.com/in/ANA/?trk=tracking#section'), 'https://www.linkedin.com/in/ana');
  assert.equal(linkedinProfileIdentity('https://m.linkedin.com/in/ana'), 'https://www.linkedin.com/in/ana');
  for (const input of ['https://user:password@linkedin.com/in/ana', 'javascript:alert(1)', 'https://linkedin.com:444/in/ana', 'https://linkedin.com.evil.test/in/ana', 'https://linkedin.com/in/ana/posts', 'https://linkedin.com/in/a%2Fb', 'https://linkedin.com/in/%0A']) assert.throws(() => linkedinProfileIdentity(input));
  for (const value of [{ notes: 'Private notes' }, { name: 'bad\nname' }, JSON.parse('{"__proto__":"fake"}'), { constructor: 'fake' }]) assert.throws(() => normalizeSourceObservations(value));
  const first = observeSourceFacts('{}', { name: 'Original name', location: null });
  const changed = observeSourceFacts(first, { name: 'New name', location: 'Lisbon' });
  assert.deepEqual(readSourceFacts(changed).name, { original_value: 'Original name', observed_value: 'New name', applied_value: null });
  assert.equal(readSourceFacts(changed).location!.original_value, null);
  assert.throws(() => readSourceFacts('{"name":{"original_value":"Ana","observed_value":"Ana","applied_value":null,"token":"fake"}}'));
});

test('self-hosted source-first and create-first flows are atomic, replay safely, preserve user fields and move links on merge', () => {
  const db = new Database(':memory:');
  try {
    initializeDatabase(db); db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO workspaces (name) VALUES ('Personal')").run();
    const key = crypto.randomUUID(), body = { profile_url: 'linkedin.com/in/source-first', fields: { name: 'Source first', headline: 'Original headline' } };
    const created = createLinkedInSource(db, body, key), replay = createLinkedInSource(db, body, key);
    assert.equal(replay.replayed, true); assert.equal(replay.contact_id, created.contact_id);
    assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 1);
    assert.throws(() => createLinkedInSource(db, { ...body, fields: { name: 'Different' } }, key), /already used/);
    assert.throws(() => createLinkedInSource(db, body, crypto.randomUUID()), /already linked/);
    assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 1, 'A rejected duplicate cannot leave an orphan person.');
    const existing = Number(db.prepare('INSERT INTO contacts (name, email, notes) VALUES (?, ?, ?)').run('My name', 'personal@example.test', 'Private note').lastInsertRowid);
    db.prepare('INSERT INTO interactions (contact_id, date, type, notes) VALUES (?, ?, ?, ?)').run(existing, '2026-10-03', 'call', 'Private history');
    const linked = createLinkedInSource(db, { contact_id: existing, profile_url: 'linkedin.com/in/existing', fields: { name: 'LinkedIn name' } }, crypto.randomUUID());
    assert.equal(listContactSources(db, existing).contact.name, 'My name');
    const refreshed = changeContactSource(db, existing, linked.source.public_id, { action: 'observe', fields: { name: 'Updated LinkedIn name' }, expected_revision: 1 });
    assert.equal(readSourceFacts(refreshed.source!.fields).name!.original_value, 'LinkedIn name');
    assert.throws(() => changeContactSource(db, existing, linked.source.public_id, { action: 'observe', fields: { name: 'Stale' }, expected_revision: 1 }), /changed/);
    const revision = listContactSources(db, existing).contact.edit_revision;
    db.prepare("UPDATE contacts SET notes = 'Changed elsewhere' WHERE id = ?").run(existing);
    assert.throws(() => changeContactSource(db, existing, linked.source.public_id, { action: 'use_name', expected_revision: 2, expected_edit_revision: revision }), /changed/);
    assert.equal(listContactSources(db, existing).sources[0].revision, 2);
    const current = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing);
    changeContactSource(db, existing, linked.source.public_id, { action: 'use_name', expected_revision: 2, expected_edit_revision: getContactEditRevision(current) });
    assert.equal(db.prepare('SELECT name FROM contacts WHERE id = ?').get(existing).name, 'Updated LinkedIn name');
    assert.equal(db.prepare('SELECT count(*) n FROM interactions').get().n, 1);
    db.prepare('UPDATE contacts SET email = ? WHERE id = ?').run('personal@example.test', created.contact_id);
    mergeContacts(db, existing, [created.contact_id]);
    assert.equal(listContactSources(db, existing).sources.length, 2);
    assert.equal(createLinkedInSource(db, body, key).contact_id, existing, 'An old create receipt reaches the merged person.');
    changeContactSource(db, existing, created.source.public_id, { expected_revision: 1 }, true);
    assert.throws(() => createLinkedInSource(db, body, key), /no longer available/);
    assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 1);
  } finally { db.close(); }
});

test('cloud source linking preserves identity, exact create receipts, workspace isolation, reviewed names and recovery', async () => {
  const h = await createCloudHarness();
  try {
    const epoch = (await h.call('sources/context')).body.epoch;
    const key = crypto.randomUUID(), body = { expected_epoch: epoch, profile_url: 'linkedin.com/in/ana', fields: { name: 'Ana', company: 'Original company' }, origin: 'provider', access_token: 'must not be stored' };
    const created = await h.call('sources/linkedin', { method: 'POST', body, key });
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.source.origin, 'user_provided');
    const contactId = created.body.contact_id, source = created.body.source;
    const replay = await h.call('sources/linkedin', { method: 'POST', body, key });
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.contact_id, contactId);
    assert.equal((await h.call('sources/linkedin', { method: 'POST', body: { ...body, fields: { name: 'Other' } }, key })).status, 409);
    assert.equal((await h.call('sources/linkedin', { method: 'POST', body })).status, 409);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM contacts WHERE workspace_id = 'test'").first())?.n, 1);
    assert.equal((await h.call(`contacts/${contactId}/sources`, { workspace: 'other' })).status, 404);
    assert.equal((await h.call('sources/linkedin', { method: 'POST', workspace: 'other', body: { contact_id: contactId, profile_url: 'linkedin.com/in/cross-workspace' } })).status, 409);
    await assert.rejects(h.db.prepare(`INSERT INTO contact_source_links (workspace_id, public_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, observed_at, created_at, updated_at)
      VALUES ('other', ?, ?, 'linkedin', 'user_provided', 'foreign', 'foreign', 'user_provided', '{}', 'now', 'now', 'now')`).bind(crypto.randomUUID(), contactId).run(), /SOURCE_LINK_OWNER/);
    const initial = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(initial);
    assert.equal(readContactSources(initial.data.source_links)[0].public_id, source.public_id);
    assert.ok(!JSON.stringify(initial).includes('must not be stored'));
    const user = (await h.call(`contacts/${contactId}`)).body.contact;
    await h.call(`contacts/${contactId}`, { method: 'PATCH', body: { name: 'My preferred name', notes: 'Private relationship note', expected_edit_revision: user.edit_revision } });
    const update = await h.call(`contacts/${contactId}/sources/${source.public_id}`, { method: 'PATCH', body: { action: 'observe', expected_revision: 1, fields: { name: 'Ana new source name', company: 'New company' } } });
    assert.equal(update.status, 200, JSON.stringify(update.body)); assert.equal(readSourceFacts(update.body.source.fields).name!.original_value, 'Ana');
    const current = (await h.call(`contacts/${contactId}`)).body.contact;
    assert.equal(current.name, 'My preferred name'); assert.equal(current.notes, 'Private relationship note');
    assert.equal((await h.call(`contacts/${contactId}/sources/${source.public_id}`, { method: 'PATCH', body: { action: 'observe', expected_revision: 1, fields: { name: 'Stale' } } })).status, 409);
    assert.equal((await h.call(`contacts/${contactId}/sources/${source.public_id}`, { method: 'PATCH', body: { action: 'use_name', expected_revision: 2, expected_edit_revision: user.edit_revision } })).status, 409);
    assert.equal((await h.call(`contacts/${contactId}/sources/${source.public_id}`, { method: 'PATCH', body: { action: 'use_name', expected_revision: 2, expected_edit_revision: current.edit_revision } })).status, 200);
    const pull = await h.call(`v3/sync/pull?epoch=${initial.data ? (await h.call('v3/sync/bootstrap')).body.cursor.epoch : ''}&sequence=0`);
    const latest = pull.body.changes.filter((change: { entity: string }) => change.entity === 'contact').at(-1).record;
    assert.equal(latest.data.name, 'Ana new source name'); assert.equal(readContactSources(latest.data.source_links)[0].revision, 3);
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal(backup.schemaVersion, 'cloud-14');
    assert.equal((await h.call(`contacts/${contactId}/sources/${source.public_id}`, { method: 'DELETE', body: { expected_revision: 3 } })).status, 200);
    assert.equal((await h.call(`contacts/${contactId}`)).body.contact.notes, 'Private relationship note');
    assert.equal((await h.call('sources/linkedin', { method: 'POST', body, key })).status, 409, 'A removed link cannot be recreated by an uncertain old request.');
    const restore = await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal((await h.call('sources/linkedin', { method: 'POST', body, key })).status, 409, 'An old source request must not replay into a replaced dataset.');
    const restored = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(restored);
    assert.equal(restored.data.source_links, latest.data.source_links);
    assert.equal((await h.call(`contacts/${contactId}/sources`)).body.sources[0].public_id, source.public_id);
    const snapshot = (await h.call(`settings/backups/${backup.filename}`)).body;
    snapshot.version = 9; delete snapshot.tables.contact_source_links; for (const contact of snapshot.tables.contacts) delete contact.source_revision;
    const legacy = await h.call('settings/restore', { method: 'POST', body: snapshot, headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' } });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body)); assert.equal((await h.call(`contacts/${contactId}/sources`)).body.sources.length, 0);
  } finally { await h.close(); }
});

test('source links move atomically with cloud merges and preserve old request identity', async () => {
  const h = await createCloudHarness();
  try {
    const primary = (await h.call('contacts', { method: 'POST', body: { name: 'My Ana', email: 'ana@example.test' } })).body.contact;
    const key = crypto.randomUUID(), body = { profile_url: 'linkedin.com/in/merged-person', fields: { name: 'Source Ana' } };
    const linked = (await h.call('sources/linkedin', { method: 'POST', body, key })).body;
    const duplicate = (await h.call(`contacts/${linked.contact_id}`)).body.contact;
    await h.call(`contacts/${linked.contact_id}`, { method: 'PATCH', body: { email: 'ana@example.test', expected_edit_revision: duplicate.edit_revision } });
    const review = (await h.call('contacts/duplicates')).body;
    const merged = await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary.id, duplicateIds: [linked.contact_id], expectedRevision: review.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal((await h.call(`contacts/${primary.id}/sources`)).body.sources[0].public_id, linked.source.public_id);
    assert.equal((await h.call('sources/linkedin', { method: 'POST', body, key })).body.contact_id, primary.id);
    assert.equal(readContactSources((await h.call('v3/sync/bootstrap')).body.records.find((row: { id: string }) => row.id === primary.public_id).data.source_links)[0].public_id, linked.source.public_id);
  } finally { await h.close(); }
});

test('private schema 10 source facts survive resumable restoration and independent graph verification', async () => {
  const h = await createCloudHarness();
  try {
    const linked = await h.call('sources/linkedin', { method: 'POST', body: { profile_url: 'linkedin.com/in/private-restored', fields: { name: 'Private snapshot person', company: 'Original company' } } });
    assert.equal(linked.status, 201);
    const original = (await h.call('v3/sync/bootstrap')).body.records[0];
    let capture = await h.beginCapture();
    for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready');
    let job = await h.beginRestorePreparation(capture.id);
    for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready'); job = await h.beginRestoreApply(job.id);
    for (let i = 0; job.state === 'deleting' && i < 100; i++) job = await h.advanceRestoreDeletion(job.id);
    assert.equal(job.state, 'awaiting_write'); job = await h.advanceRestoreWriting(job.id);
    for (let i = 0; job.state === 'writing' && i < 100; i++) job = await h.advanceRestoreWriting(job.id);
    assert.equal(job.state, 'repairing_dates');
    for (let i = 0; job.state === 'repairing_dates' && i < 100; i++) job = await h.advanceRestoreDateRepair(job.id);
    assert.equal(job.state, 'verifying');
    for (let i = 0; job.state === 'verifying' && i < 100; i++) job = await h.advanceRestoreVerification(job.id);
    assert.equal(job.state, 'completed');
    const restored = (await h.call('v3/sync/bootstrap')).body.records[0];
    assert.equal(restored.id, original.id); assert.equal(restored.data.source_links, original.data.source_links);
    assert.equal(restored.data.source_revision, original.data.source_revision);
  } finally { await h.close(); }
});

test('source bounds reject excess links atomically and maintenance cannot accept source observations', async () => {
  const h = await createCloudHarness();
  try {
    const person = (await h.call('contacts', { method: 'POST', body: { name: 'Bounded person' } })).body.contact;
    const entries = Array.from({ length: 32 }, (_, index) => ({ id: crypto.randomUUID(), url: `https://www.linkedin.com/in/bounded-${index}` }));
    const now = new Date().toISOString();
    await h.db.prepare(`INSERT INTO contact_source_links (workspace_id, public_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, revision, observed_at, created_at, updated_at)
      SELECT 'test', json_extract(value, '$.id'), ?, 'linkedin', 'user_provided', json_extract(value, '$.url'), json_extract(value, '$.url'), 'user_provided', '{}', 1, ?, ?, ? FROM json_each(?)`)
      .bind(person.id, now, now, now, JSON.stringify(entries)).run();
    const before = (await h.call('v3/sync/bootstrap')).body.records[0];
    const extra = await h.call('sources/linkedin', { method: 'POST', body: { contact_id: person.id, profile_url: 'linkedin.com/in/one-too-many' } });
    assert.equal(extra.status, 409);
    assert.equal((await h.call('v3/sync/bootstrap')).body.records[0].revision, before.revision);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_source_links').first())?.n, 32);
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'erasing' WHERE id = 'test'").run();
    const update = await h.call(`contacts/${person.id}/sources/${entries[0].id}`, { method: 'PATCH', body: { action: 'observe', expected_revision: 1, fields: { company: 'During maintenance' } } });
    assert.equal(update.status, 409);
    assert.equal((await h.db.prepare('SELECT revision FROM contact_source_links WHERE public_id = ?').bind(entries[0].id).first())?.revision, 1);
  } finally { await h.close(); }
});
