import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { parseLinkedInExport, MAX_LINKEDIN_EXPORT_BYTES } from '../lib/linkedin-export.ts';
import { previewLocalLinkedInImport, importLocalLinkedInRow } from '../lib/linkedin-import.ts';
import { readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { readSourceFacts } from '../packages/domain/src/contact-sources.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { DEVICE_TOKEN_PREFIX, readNativeAccount } from '../packages/domain/src/devices.ts';
const header = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const observation = { profile_url: 'https://www.linkedin.com/in/export-ana', fields: { name: 'Export Ana', email: 'export@example.test', company: 'Original company', title: 'Engineer', connected_on: '03 Oct 2026' } };
function choice(preview: ReturnType<typeof previewLocalLinkedInImport>, row = observation, person: number | null = null) {
  return { ...row, contact_id: person, create_name: person === null ? 'My export name' : null, use_name: false, use_email: true,
    expected_epoch: preview.epoch, expected_contact_revision: preview.target?.edit_revision ?? null,
    expected_source: preview.source ? { public_id: preview.source.public_id, revision: preview.source.revision } : null };
}
function local() { const db = new Database(':memory:'); initializeDatabase(db); db.pragma('foreign_keys = ON'); db.prepare("INSERT INTO workspaces (name) VALUES ('Personal')").run(); return db; }

test('LinkedIn CSV handles notes, BOM, quotes, accents, missing URLs and duplicate canonical profiles without automatic matching', () => {
  const rows = parseLinkedInExport(`\uFEFFNotes:\r\nExported email availability depends on members.\r\n\r\n${header}\r\nAna,Amarál,linkedin.com/in/ANA/?trk=x,ana@example.test,"Company, Inc.","Engineer ""II""",3 Oct 2026\r\nOther,Person,https://www.linkedin.com/in/ana,,Other,Founder,04 Oct 2026\r\n`);
  assert.equal(rows.length, 2); assert.equal(rows[0].fields.name, 'Ana Amarál'); assert.equal(rows[0].fields.company, 'Company, Inc.'); assert.equal(rows[0].fields.title, 'Engineer "II"');
  assert.equal(rows[0].profile_url, 'https://www.linkedin.com/in/ana'); assert.deepEqual(rows[0].duplicates, [2]); assert.deepEqual(rows[1].duplicates, [1]); assert.equal(rows[1].fields.email, null);
  const old = parseLinkedInExport('First Name,Last Name,Email Address,Company,Position,Connected On\nAna,Legacy,,Company,Role,01 Jan 2020\n');
  assert.equal(old[0].profile_url, null); assert.equal(old[0].issue, null);
});

test('LinkedIn CSV rejects malformed structure, unrelated archive categories, oversized data and unsafe profile identities', () => {
  for (const bad of ['Sender,Recipient,Message\na,b,private', `${header},Notes\na,b,url,email,company,title,date,private`, header.replace('Company', 'URL'),
    `${header}\n"bad"trailing,b,linkedin.com/in/x,,c,p,d`, `${header}\n"unterminated`, 'x'.repeat(MAX_LINKEDIN_EXPORT_BYTES + 1),
    header + '\n' + 'a,b,linkedin.com/in/x,,c,p,d\n'.repeat(5001)]) assert.throws(() => parseLinkedInExport(bad));
  const rows = parseLinkedInExport(`${header}\nAna,B,https://evil.test/in/a,,c,p,d\nAna,B,linkedin.com/in/a,,c,p,d,extra\n`);
  assert.ok(rows.every((row) => row.issue));
  const repeated = parseLinkedInExport(header + '\n' + 'a,b,linkedin.com/in/x,,c,p,d\n'.repeat(5000));
  assert.equal(repeated.length, 5000); assert.equal(repeated.at(-1)!.duplicates.length, 10); assert.equal(repeated.at(-1)!.duplicate_count, 4999);
});

test('self-hosted export create, attach, observation updates and durable receipts preserve private data and preferred methods', () => {
  const db = local();
  try {
    const key = crypto.randomUUID(), preview = previewLocalLinkedInImport(db, observation), input = choice(preview);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 0);
    const first = importLocalLinkedInRow(db, input, key); assert.equal(first.replayed, false);
    assert.equal(importLocalLinkedInRow(db, input, key).replayed, true);
    const person = db.prepare('SELECT * FROM contacts WHERE id = ?').get(first.contact_id);
    assert.equal(person.name, 'My export name'); assert.equal(person.email, 'export@example.test');
    const changed = { ...observation, fields: { ...observation.fields, name: 'Updated export name', email: 'later@example.test', company: 'Later company' } };
    db.prepare("UPDATE contacts SET name = 'My correction', notes = 'Private history' WHERE id = ?").run(first.contact_id);
    const next = previewLocalLinkedInImport(db, { ...changed, contact_id: first.contact_id });
    const updateKey = crypto.randomUUID(), updated = importLocalLinkedInRow(db, choice(next, changed, first.contact_id), updateKey);
    const facts = readSourceFacts(updated.source.fields); assert.equal(facts.company!.original_value, 'Original company'); assert.equal(facts.company!.observed_value, 'Later company');
    assert.equal(facts.title!.original_value, 'Engineer'); assert.equal(facts.connected_on!.original_value, '03 Oct 2026');
    const current = db.prepare('SELECT * FROM contacts WHERE id = ?').get(first.contact_id);
    assert.equal(current.name, 'My correction'); assert.equal(current.notes, 'Private history'); assert.equal(current.email, 'export@example.test');
    assert.equal(readContactMethods(current.contact_methods).length, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 1);
    db.prepare("UPDATE app_metadata SET updated_at = '2000-01-01' WHERE key LIKE 'durable-idempotency:%'").run();
    assert.equal(importLocalLinkedInRow(db, input, key).source.revision, 2);
    db.prepare('DELETE FROM contact_source_links WHERE public_id = ?').run(first.source.public_id);
    assert.throws(() => importLocalLinkedInRow(db, input, key), /no longer available/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 1);
  } finally { db.close(); }
});

test('self-hosted export guards stale person/source choices, invalid emails and restore epochs before any mutation', () => {
  const db = local();
  try {
    const id = Number(db.prepare("INSERT INTO contacts (name, notes) VALUES ('My Ana', 'Private')").run().lastInsertRowid);
    const preview = previewLocalLinkedInImport(db, { ...observation, contact_id: id }), input = choice(preview, observation, id);
    db.prepare("UPDATE contacts SET notes = 'New note' WHERE id = ?").run(id);
    assert.throws(() => importLocalLinkedInRow(db, input, crypto.randomUUID()), /person changed/);
    const fresh = choice(previewLocalLinkedInImport(db, { ...observation, contact_id: id }), observation, id);
    assert.throws(() => importLocalLinkedInRow(db, { ...fresh, fields: { ...fresh.fields, email: 'not email' } }, crypto.randomUUID()), /valid email/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contact_source_links').get().n, 0);
    const saved = importLocalLinkedInRow(db, fresh, crypto.randomUUID()); assert.equal(saved.contact_id, id);
    assert.throws(() => importLocalLinkedInRow(db, fresh, crypto.randomUUID()), /changed/);
    db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'source-write-epoch'").run(crypto.randomUUID());
    assert.throws(() => importLocalLinkedInRow(db, fresh, crypto.randomUUID()), /restored/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contact_source_links').get().n, 1);
  } finally { db.close(); }
});

test('cloud export review creates or attaches one person, updates the same source and retries the exact reviewed operation', async () => {
  const h = await createCloudHarness();
  try {
    const preview = await h.call('sources/linkedin/import/preview', { method: 'POST', body: observation }); assert.equal(preview.status, 200);
    assert.equal((await h.call('contacts')).body.contacts.length, 0);
    const key = crypto.randomUUID(), input = choice(preview.body);
    const created = await h.call('sources/linkedin/import', { method: 'POST', body: input, key }); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: input, key })).body.replayed, true);
    const id = created.body.contact_id, original = (await h.call(`contacts/${id}`)).body.contact;
    await h.call(`contacts/${id}`, { method: 'PATCH', body: { name: 'My web correction', notes: 'Private web history', expected_edit_revision: original.edit_revision } });
    const row = { ...observation, fields: { ...observation.fields, name: 'Another exported name', email: 'new-export@example.test', company: 'Updated company' } };
    const fresh = (await h.call('sources/linkedin/import/preview', { method: 'POST', body: { ...row, contact_id: id } })).body;
    assert.equal(fresh.source.public_id, created.body.source.public_id); assert.equal(fresh.target.name, 'My web correction');
    const updated = await h.call('sources/linkedin/import', { method: 'POST', body: choice(fresh, row, id) }); assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const person = (await h.call(`contacts/${id}`)).body.contact;
    assert.equal(person.name, 'My web correction'); assert.equal(person.email, 'export@example.test'); assert.equal(person.notes, 'Private web history'); assert.equal(readContactMethods(person.contact_methods).length, 2);
    const facts = readSourceFacts(updated.body.source.fields); assert.equal(facts.name!.original_value, 'Export Ana'); assert.equal(facts.name!.applied_value, 'My export name'); assert.equal(facts.company!.observed_value, 'Updated company');
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: input, key })).body.source.revision, 2);
    const wrong = await h.call('sources/linkedin/import', { method: 'POST', body: { ...input, use_name: true }, key }); assert.equal(wrong.status, 409);
    assert.equal((await h.call('contacts')).body.contacts.length, 1);
    const source = (await h.call('v3/sync/bootstrap')).body.records[0].data.source_links;
    assert.equal(readSourceFacts(JSON.parse(source)[0].fields).connected_on!.original_value, '03 Oct 2026');
  } finally { await h.close(); }
});

test('cloud import rejects stale, foreign, invalid and restored previews and never revives an unlinked source', async () => {
  const h = await createCloudHarness();
  try {
    const first = (await h.call('contacts', { method: 'POST', body: { name: 'Existing Ana', email: 'preferred@example.test', notes: 'Private' } })).body.contact;
    const preview = (await h.call('sources/linkedin/import/preview', { method: 'POST', body: { ...observation, contact_id: first.id } })).body, input = choice(preview, observation, first.id);
    const edited = await h.call(`contacts/${first.id}`, { method: 'PATCH', body: { notes: 'New note', expected_edit_revision: preview.target.edit_revision } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: input })).status, 409);
    assert.equal((await h.call('sources/linkedin/import/preview', { method: 'POST', body: { ...observation, contact_id: first.id }, workspace: 'other' })).status, 404);
    const fresh = choice((await h.call('sources/linkedin/import/preview', { method: 'POST', body: { ...observation, contact_id: first.id } })).body, observation, first.id);
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: { ...fresh, fields: { ...fresh.fields, notes: 'Must not become source facts' } } })).status, 400);
    const key = crypto.randomUUID(), saved = await h.call('sources/linkedin/import', { method: 'POST', body: fresh, key }); assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const before = (await h.call(`contacts/${first.id}`)).body.contact; assert.equal(before.email, 'preferred@example.test'); assert.equal(before.notes, 'New note');
    await h.call(`contacts/${first.id}/sources/${saved.body.source.public_id}`, { method: 'DELETE', body: { expected_revision: 1 } });
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: fresh, key })).status, 409);
    await h.db.prepare('UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), 'test').run();
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: fresh, key })).status, 409);
    assert.equal((await h.call('contacts')).body.contacts.length, 1);
  } finally { await h.close(); }
});

test('concurrent cloud row confirmations commit once and competing first links cannot leave orphan people', async () => {
  const h = await createCloudHarness();
  try {
    const input = choice((await h.call('sources/linkedin/import/preview', { method: 'POST', body: observation })).body), key = crypto.randomUUID();
    const both = await Promise.all([h.call('sources/linkedin/import', { method: 'POST', body: input, key }), h.call('sources/linkedin/import', { method: 'POST', body: input, key })]);
    assert.ok(both.every((result) => [200, 201].includes(result.status)), JSON.stringify(both));
    assert.equal((await h.call('contacts')).body.contacts.length, 1);
    const newRow = { ...observation, profile_url: 'linkedin.com/in/another-export' }, next = choice((await h.call('sources/linkedin/import/preview', { method: 'POST', body: newRow })).body, newRow);
    const competing = await Promise.all([h.call('sources/linkedin/import', { method: 'POST', body: next }), h.call('sources/linkedin/import', { method: 'POST', body: next })]);
    assert.equal(competing.filter((result) => result.status === 201).length, 1); assert.equal((await h.call('contacts')).body.contacts.length, 2);
  } finally { await h.close(); }
});

test('export receipts follow merges and all exported facts survive recovery and a fresh native offline cache', async () => {
  const h = await createCloudHarness();
  try {
    const input = choice((await h.call('sources/linkedin/import/preview', { method: 'POST', body: observation })).body), key = crypto.randomUUID();
    const created = await h.call('sources/linkedin/import', { method: 'POST', body: input, key }); assert.equal(created.status, 201, JSON.stringify(created.body));
    const duplicate = (await h.call(`contacts/${created.body.contact_id}`)).body.contact;
    const primary = (await h.call('contacts', { method: 'POST', body: { name: 'Survivor', email: 'export@example.test', notes: 'Keep survivor history' } })).body.contact;
    const review = await h.call('contacts/duplicates');
    const merged = await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary.id, duplicateIds: [duplicate.id], expectedRevision: review.body.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: input, key })).body.contact_id, primary.id);
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const source = (await h.call(`contacts/${primary.id}/sources`)).body.sources[0];
    await h.call(`contacts/${primary.id}/sources/${source.public_id}`, { method: 'DELETE', body: { expected_revision: source.revision } });
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    assert.equal((await h.call('sources/linkedin/import', { method: 'POST', body: input, key })).status, 409);
    const record = (await h.call('v3/sync/bootstrap')).body.records.find((row: { id: string }) => row.id === primary.public_id);
    const facts = readSourceFacts(JSON.parse(record.data.source_links)[0].fields); assert.equal(facts.title!.original_value, 'Engineer'); assert.equal(facts.email!.original_value, 'export@example.test');
    const account = readNativeAccount({ deviceId: crypto.randomUUID(), userId: 'owner', workspaceId: 'test', email: 'owner@example.test', name: 'Owner', expiresAt: '2030-01-01T00:00:00.000Z',
      origin: 'https://everclosecrm.com', token: DEVICE_TOKEN_PREFIX + Buffer.alloc(32, 33).toString('base64url') });
    const mobile = await createMobileHarness(account);
    try {
      const fetcher: typeof fetch = async (url, init) => {
        const path = String(url).split('/api/')[1], response = await h.call(path, { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(response.body, { status: response.status });
      };
      await mobile.sync.syncWorkspace(mobile.db, account, { fetcher });
      const cached = (await mobile.contacts.getContact(mobile.db, primary.public_id))!;
      assert.equal(cached.notes, 'Keep survivor history'); assert.equal(readSourceFacts(JSON.parse(cached.source_links!)[0].fields).connected_on!.original_value, '03 Oct 2026');
    } finally { mobile.close(); }
  } finally { await h.close(); }
});

test('source-capacity rejection rolls back imported methods and name choices without retaining a successful receipt', async () => {
  const h = await createCloudHarness();
  try {
    const person = (await h.call('contacts', { method: 'POST', body: { name: 'Keep private name', notes: 'Private context' } })).body.contact;
    for (let index = 0; index < 32; index++) assert.equal((await h.call('sources/linkedin', { method: 'POST', body: { contact_id: person.id, profile_url: `linkedin.com/in/cap-${index}`, fields: {} } })).status, 201);
    const preview = (await h.call('sources/linkedin/import/preview', { method: 'POST', body: { ...observation, contact_id: person.id } })).body, key = crypto.randomUUID();
    const rejected = await h.call('sources/linkedin/import', { method: 'POST', key, body: { ...choice(preview, observation, person.id), use_name: true } }); assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    const unchanged = (await h.call(`contacts/${person.id}`)).body.contact; assert.equal(unchanged.name, 'Keep private name'); assert.equal(unchanged.email, null); assert.equal(unchanged.notes, 'Private context');
    assert.equal(await h.db.prepare("SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ?").bind('test', key).first(), null);
  } finally { await h.close(); }
});
