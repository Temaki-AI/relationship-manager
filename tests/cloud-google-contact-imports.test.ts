import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor, googleEnvironment as environment, stagedGoogleContact, googleImportBody, currentPerson, googlePerson } from './helpers/google-contact-fixture.ts';
import { readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { readProviderSources, readProviderFacts, readAppliedProviderFields } from '../packages/domain/src/provider-sources.ts';
import { readSyncRecord } from '../packages/domain/src/sync-client.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { createHash } from 'node:crypto';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function count(h: Harness, table: string) { return (await h.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace_id = 'test'`).first<{ n: number }>())!.n; }
async function importPerson(h: Harness, c: { id: string }, body: Record<string, unknown>, key = crypto.randomUUID()) { return h.contactImports.importGoogleContact(h.db, actor, environment, c.id, body, key); }

test('selected import creates one canonical person with authenticated source facts and an exact retry receipt', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), body = googleImportBody(preview), key = crypto.randomUUID();
    const result = await importPerson(h, c, body, key), contact = await currentPerson(h, result.contact_id);
    assert.equal(contact.name, 'My Ana'); assert.equal(contact.email, 'ana@example.test'); assert.equal(contact.phone, '+351912345678');
    assert.equal(readContactMethods(contact.contact_methods).length, 2); assert.equal(contact.notes, null);
    assert.equal(result.source.account_key, 'google-owner'); assert.equal(result.source.account_email, 'owner@example.test');
    assert.equal(readProviderFacts(result.source.original_facts).emails.length, 2); assert.ok(!JSON.stringify(result).includes('Never import this note'));
    const applied = readAppliedProviderFields(result.source.applied_fields); assert.equal(applied.name, null); assert.equal(applied.methods.length, 2);
    assert.equal(applied.methods.find((m) => m.method.kind === 'phone')!.source_value, '+351 912 345 678');
    const retried = await importPerson(h, c, body, key); assert.equal(retried.replayed, true); assert.equal(retried.contact_id, result.contact_id);
    assert.equal(await count(h, 'contacts'), 1); assert.equal(await count(h, 'contact_provider_links'), 1);
    await assert.rejects(importPerson(h, c, { ...body, emails: [1] }, key), /different selections/);
    await assert.rejects(importPerson(h, c, body), /already linked/);
    const record = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(record);
    assert.equal(readProviderSources(record.data.provider_links)[0].public_id, key); assert.equal(record.data.source_links, '[]');
    assert.ok(!JSON.stringify(record).includes('access-secret')); assert.ok(!JSON.stringify(record).includes('refresh-secret'));
    assert.equal((await h.contactImports.savedProviderSources(h.db, actor, contact.id)).links[0].public_id, key);
  } finally { await h.close(); }
});

test('attaching selected fields preserves private details, method identities and existing preferred values; matches require confirmation', async () => {
  const h = await createCloudHarness(); try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Preferred Ana', email: 'ANA@example.test', phone: '+351123456789', notes: 'Private history', nickname: 'Nana', tags: ['Friends'] } })).body.contact;
    const methods = readContactMethods(contact.contact_methods);
    const { connection: c, query } = await stagedGoogleContact(h); query.set('contact_id', String(contact.id));
    const preview = await h.contactImports.googleImportPreview(h.db, actor, c.id, query); assert.equal(preview.matches[0].id, contact.id); assert.equal(preview.target!.name, 'Preferred Ana');
    const result = await importPerson(h, c, googleImportBody(preview, { contact_id: contact.id, expected_edit_revision: preview.target!.edit_revision, create_name: null, emails: [0, 1] }));
    const after = await currentPerson(h, result.contact_id), final = readContactMethods(after.contact_methods);
    assert.equal(after.name, 'Preferred Ana'); assert.equal(after.notes, 'Private history'); assert.equal(after.nickname, 'Nana'); assert.equal(after.tags, JSON.stringify(['Friends']));
    for (const original of methods) assert.deepEqual(final.find((m) => m.id === original.id), original);
    assert.equal(after.email, 'ANA@example.test'); assert.equal(after.phone, '+351123456789'); assert.equal(final.length, 4);
    assert.equal(readAppliedProviderFields(result.source.applied_fields).methods.find((m) => m.method.kind === 'email' && m.source_value === 'ana@example.test')!.method.id, methods.find((m) => m.kind === 'email')!.id);
    assert.equal(await count(h, 'contacts'), 1);
    // Name equality alone is not proof that a source and a relationship are the same person.
    const source = googlePerson(); source.emailAddresses = []; source.phoneNumbers = [];
    const newFacts = h.googleContacts.readGoogleContactChange(source).contacts[0];
    await h.db.prepare('UPDATE provider_contact_index SET facts = ? WHERE connection_id = ?').bind(JSON.stringify(newFacts), c.id).run();
    query.delete('contact_id'); assert.equal((await h.contactImports.googleImportPreview(h.db, actor, c.id, query)).matches.length, 0);
  } finally { await h.close(); }
});

test('stale source, stale person, forged facts, malformed selections and owner boundaries cannot commit an import', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview, query } = await stagedGoogleContact(h), body = googleImportBody(preview);
    for (const override of [{ facts_revision: '0'.repeat(64) }, { emails: [99] }, { phones: [0, 0] }, { original_facts: '{}' }, { create_name: '' }]) await assert.rejects(importPerson(h, c, { ...body, ...override }));
    assert.equal(await count(h, 'contacts'), 0); assert.equal(await count(h, 'contact_provider_links'), 0);
    await assert.rejects(h.contactImports.importGoogleContact(h.db, { ...actor, authMethod: 'device' }, environment, c.id, body, crypto.randomUUID()), /web app/);
    await assert.rejects(h.contactImports.importGoogleContact(h.db, { ...actor, workspaceId: 'other' }, environment, c.id, body, crypto.randomUUID()), /owner/);
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Existing' } })).body.contact; query.set('contact_id', String(contact.id));
    const targetPreview = await h.contactImports.googleImportPreview(h.db, actor, c.id, query);
    await h.call('contacts/' + contact.id, { method: 'PATCH', body: { notes: 'Latest correction', expected_edit_revision: targetPreview.target!.edit_revision } });
    await assert.rejects(importPerson(h, c, googleImportBody(targetPreview, { contact_id: contact.id, create_name: null, expected_edit_revision: targetPreview.target!.edit_revision })), /person changed/);
    assert.equal((await currentPerson(h, contact.id)).notes, 'Latest correction'); assert.equal(await count(h, 'contact_provider_links'), 0);
    await h.db.prepare('UPDATE provider_contact_resources SET active_generation = ? WHERE connection_id = ?').bind(crypto.randomUUID(), c.id).run();
    await assert.rejects(importPerson(h, c, body), /downloaded contact changed/);
  } finally { await h.close(); }
});

test('a name-only source attachment preserves a deliberately absent preferred method without creating a new primary', async () => {
  const h = await createCloudHarness(); try {
    const created = await h.call('contacts', { method: 'POST', body: { name: 'My name', contact_methods: [{ id: crypto.randomUUID(), kind: 'email', value: 'ana@example.test', label: 'Alternate', country: null, preferred: false }] } });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const contact = created.body.contact;
    assert.equal(contact.email, null);
    const { connection: c, query } = await stagedGoogleContact(h); query.set('contact_id', String(contact.id));
    const preview = await h.contactImports.googleImportPreview(h.db, actor, c.id, query);
    const imported = await importPerson(h, c, googleImportBody(preview, { contact_id: contact.id, create_name: null, expected_edit_revision: preview.target!.edit_revision, use_name: true, emails: [], phones: [] }));
    const after = await currentPerson(h, imported.contact_id); assert.equal(after.name, 'Google Ana'); assert.equal(after.email, null); assert.equal(after.phone, null);
    assert.deepEqual(readContactMethods(after.contact_methods), readContactMethods(contact.contact_methods));
    assert.equal(readAppliedProviderFields(imported.source.applied_fields).name, 'Google Ana');
  } finally { await h.close(); }
});

test('a receipt follows a merged person; disconnect keeps saved source facts and unlink keeps imported fields', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), body = googleImportBody(preview), key = crypto.randomUUID();
    const imported = await importPerson(h, c, body, key);
    const primary = (await h.call('contacts', { method: 'POST', body: { name: 'Private Ana', email: 'ana@example.test', notes: 'Keep this note' } })).body.contact;
    const review = await h.call('contacts/duplicates');
    const merged = await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary.id, duplicateIds: [imported.contact_id], expectedRevision: review.body.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body)); assert.equal((await importPerson(h, c, body, key)).contact_id, primary.id);
    await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.id, c.revision, async () => new Response(null, { status: 200 }));
    assert.equal((await importPerson(h, c, body, key)).contact_id, primary.id);
    const saved = await h.contactImports.savedProviderSources(h.db, actor, primary.id); assert.equal(saved.links.length, 1);
    await assert.rejects(h.contactImports.unlinkProviderSource(h.db, actor, primary.id, key, { expected_epoch: saved.epoch, expected_revision: 2 }), /CLOUD_RECOVERY_CONFLICT/);
    await h.contactImports.unlinkProviderSource(h.db, actor, primary.id, key, { expected_epoch: saved.epoch, expected_revision: 1 });
    const after = await currentPerson(h, primary.id); assert.ok(after.notes.includes('Keep this note')); assert.ok(readContactMethods(after.contact_methods).some((m) => m.value === '+351912345678'));
    assert.equal(await count(h, 'contact_provider_links'), 0); await assert.rejects(importPerson(h, c, body, key), /no longer available/);
  } finally { await h.close(); }
});

test('backups and restore retain source provenance, clear operational accounts and reject pre-restore imports; genuine v10 snapshots normalize the new table', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), body = googleImportBody(preview), key = crypto.randomUUID();
    const imported = await importPerson(h, c, body, key), backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal(backup.schemaVersion, 'cloud-14');
    const snapshot = (await h.call('settings/backups/' + backup.filename)).body;
    assert.equal(snapshot.version, 14); assert.equal(snapshot.tables.contact_provider_links.length, 1); assert.ok(!JSON.stringify(snapshot).includes('access-secret'));
    await h.contactImports.unlinkProviderSource(h.db, actor, imported.contact_id, key, { expected_epoch: preview.epoch, expected_revision: 1 });
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const saved = await h.contactImports.savedProviderSources(h.db, actor, imported.contact_id); assert.equal(saved.links[0].original_facts, imported.source.original_facts);
    await assert.rejects(importPerson(h, c, body, key), /dataset changed/);
    const record = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(record); assert.equal(readProviderSources(record.data.provider_links).length, 1);
    snapshot.version = 10; delete snapshot.tables.contact_provider_links; delete snapshot.tables.provider_field_rules; delete snapshot.tables.contact_device_links;
    const old = await h.call('settings/restore', { method: 'POST', body: snapshot, headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' } }); assert.equal(old.status, 200, JSON.stringify(old.body));
    assert.equal((await h.contactImports.savedProviderSources(h.db, actor, imported.contact_id)).links.length, 0);
  } finally { await h.close(); }
});

test('import HTTP routes enforce origin and bounded JSON; saved source routes and API rewrites are available', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), body = googleImportBody(preview), key = crypto.randomUUID();
    const path = ['connections', c.id, 'contacts', 'import'];
    const make = (origin: string, value: unknown) => new Request('https://test.invalid/api/' + path.join('/'), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });
    assert.equal((await h.providerApi.handleProviderConnections(make('https://other.invalid', body), actor, path)).status, 403);
    assert.equal((await h.providerApi.handleProviderConnections(make(environment.BETTER_AUTH_URL, { ...body, huge: 'x'.repeat(5000) }), actor, path)).status, 413);
    const imported = await h.providerApi.handleProviderConnections(make(environment.BETTER_AUTH_URL, body), actor, path); assert.equal(imported.status, 200, await imported.clone().text());
    const result = await imported.json() as { contact_id: number };
    const sourcePath = ['contacts', String(result.contact_id), 'provider-sources'];
    const listed = await h.providerSourceApi.handleProviderSources(new Request('https://test.invalid/api/' + sourcePath.join('/')), actor, sourcePath); assert.equal(listed.status, 200);
    for (const suffix of ['import-preview', 'import']) assert.equal(getCloudApiRewrite('/api/connections/' + c.id + '/contacts/' + suffix), '/api/cloud/connections/' + c.id + '/contacts/' + suffix);
    assert.equal(getCloudApiRewrite('/api/contacts/1/provider-sources/' + key), '/api/cloud/contacts/1/provider-sources/' + key);
  } finally { await h.close(); }
});

test('concurrent exact retries and competing import keys cannot leave duplicate people or partial receipts', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), body = googleImportBody(preview), key = crypto.randomUUID();
    const [a, b] = await Promise.all([importPerson(h, c, body, key), importPerson(h, c, body, key)]);
    assert.equal(a.contact_id, b.contact_id); assert.equal(a.source.public_id, b.source.public_id); assert.equal(await count(h, 'contacts'), 1);
  } finally { await h.close(); }
  const second = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(second), body = googleImportBody(preview);
    const results = await Promise.allSettled([importPerson(second, c, body), importPerson(second, c, body)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count(second, 'contacts'), 1); assert.equal(await count(second, 'contact_provider_links'), 1);
    assert.equal((await second.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'google-contact-import'").first())!.n, 1);
  } finally { await second.close(); }
});

test('commit fences reject source-generation, person, permission and recovery changes after the opening reads', async () => {
  for (const boundary of ['generation', 'person', 'permission', 'restore'] as const) {
    const h = await createCloudHarness(); try {
      const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Existing', notes: 'Original' } })).body.contact;
      const { connection: c, query } = await stagedGoogleContact(h); query.set('contact_id', String(contact.id));
      const preview = await h.contactImports.googleImportPreview(h.db, actor, c.id, query), body = googleImportBody(preview, { contact_id: contact.id, create_name: null, expected_edit_revision: preview.target!.edit_revision });
      const original = h.db.batch.bind(h.db); let injected = false;
      const fencedDb = { prepare: h.db.prepare.bind(h.db), batch: async (statements: Parameters<typeof h.db.batch>[0]) => {
        if (!injected && statements.length >= 10) {
          injected = true;
          if (boundary === 'generation') await h.db.prepare('UPDATE provider_contact_resources SET active_generation = ? WHERE connection_id = ?').bind(crypto.randomUUID(), c.id).run();
          if (boundary === 'person') await h.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').bind('Concurrent correction', contact.id).run();
          if (boundary === 'permission') await h.db.prepare("UPDATE provider_connections SET status = 'reconnect_required', credentials = NULL, revision = revision + 1, authorization_revision = authorization_revision + 1 WHERE id = ?").bind(c.id).run();
          if (boundary === 'restore') await h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
        }
        return original(statements);
      } } as typeof h.db;
      await assert.rejects(h.contactImports.importGoogleContact(fencedDb, actor, environment, c.id, body, crypto.randomUUID()), /CLOUD_RECOVERY_CONFLICT/); assert.equal(injected, true);
      assert.equal(await count(h, 'contact_provider_links'), 0); assert.equal(await count(h, 'contacts'), 1);
      const saved = await currentPerson(h, contact.id); assert.equal(saved.email, null); assert.equal(saved.notes, boundary === 'person' ? 'Concurrent correction' : 'Original');
      assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'google-contact-import'").first())!.n, 0);
    } finally { await h.close(); }
  }
});

test('private resumable recovery restores provider provenance and rebuilds the same readonly phone projection', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), imported = await importPerson(h, c, googleImportBody(preview));
    let capture = await h.beginCapture();
    for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready');
    await h.contactImports.unlinkProviderSource(h.db, actor, imported.contact_id, imported.source.public_id, { expected_epoch: preview.epoch, expected_revision: 1 });
    let job = await h.beginRestorePreparation(capture.id);
    for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready'); job = await h.beginRestoreApply(job.id);
    for (let i = 0; job.state === 'deleting' && i < 100; i++) job = await h.advanceRestoreDeletion(job.id);
    for (let i = 0; ['awaiting_write', 'writing'].includes(job.state) && i < 100; i++) job = await h.advanceRestoreWriting(job.id);
    for (let i = 0; job.state === 'repairing_dates' && i < 100; i++) job = await h.advanceRestoreDateRepair(job.id);
    for (let i = 0; job.state === 'verifying' && i < 100; i++) job = await h.advanceRestoreVerification(job.id);
    assert.equal(job.state, 'completed');
    const record = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(record);
    assert.deepEqual(readProviderSources(record.data.provider_links)[0], imported.source);
  } finally { await h.close(); }
});

test('source collection bounds protect normal writes, paused restoration and whole-graph validation before replacement', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h), imported = await importPerson(h, c, googleImportBody(preview));
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await h.call('settings/backups/' + backup.filename)).body;
    const row = snapshot.tables.contact_provider_links[0];
    const excess = structuredClone(snapshot); excess.tables.contact_provider_links = Array.from({ length: 33 }, (_, index) => {
      const facts = { ...readProviderFacts(row.original_facts), sourceId: 'source' + index, resourceName: 'people/source' + index };
      return { ...row, id: index + 1, public_id: crypto.randomUUID(), external_id: facts.sourceId, resource_name: facts.resourceName, original_facts: JSON.stringify(facts), observed_facts: JSON.stringify(facts) };
    });
    assert.throws(() => h.validateCloudSnapshot(excess, 'test'), /Too many/);
    const largeFacts = { ...preview.facts, emails: Array.from({ length: 70 }, (_, i) => ({ value: 'a'.repeat(180) + i + '@example.test', primary: false, label: 'work', canonical: null })) };
    const large = structuredClone(snapshot); large.tables.contact_provider_links = Array.from({ length: 5 }, (_, index) => {
      const facts = { ...largeFacts, sourceId: 'large' + index, resourceName: 'people/large' + index };
      return { ...row, id: index + 1, public_id: crypto.randomUUID(), external_id: facts.sourceId, resource_name: facts.resourceName, original_facts: JSON.stringify(facts), observed_facts: JSON.stringify(facts) };
    });
    assert.throws(() => h.validateCloudSnapshot(large, 'test'), /oversized/);
    await h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    const columns = Object.keys(row).filter((key) => key !== 'id'); let rejected = false;
    for (const link of large.tables.contact_provider_links) {
      try { await h.db.prepare(`INSERT INTO contact_provider_links (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map((column) => link[column])).run(); }
      catch (error) { assert.match(String(error), /PROVIDER_LINK_LIMIT/); rejected = true; break; }
    }
    assert.equal(rejected, true); assert.ok(await count(h, 'contact_provider_links') < 6);
    assert.equal((await currentPerson(h, imported.contact_id)).name, 'My Ana');
  } finally { await h.close(); }
});

test('a genuine private schema-10 manifest omits provider links and remains readable without changing its old part chain', async () => {
  const h = await createCloudHarness(); try {
    const person = (await h.call('sources/linkedin', { method: 'POST', body: { profile_url: 'linkedin.com/in/old-private-source', fields: { name: 'Old private person' } } })).body;
    let capture = await h.beginCapture();
    for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready');
    const prefix = 'test/recovery-jobs/' + capture.id;
    const root = JSON.parse(await (await h.assets.get(prefix + '/manifest-' + capture.manifest_sha256 + '.json'))!.text());
    const chain = root.partsChainSha256; root.snapshotSchemaVersion = 10; root.tableOrder = root.tableOrder.filter((t: string) => !['contact_provider_links', 'provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(t)); delete root.rowCounts.contact_provider_links; delete root.rowCounts.provider_field_rules; delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    const bytes = new TextEncoder().encode(JSON.stringify(root)), hash = createHash('sha256').update(bytes).digest('hex');
    await h.assets.put(prefix + '/manifest-' + hash + '.json', bytes, { customMetadata: { workspaceId: 'test', jobId: capture.id, sha256: hash } });
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_bytes = ? WHERE id = ?').bind(hash, bytes.byteLength, capture.id).run();
    let job = await h.beginRestorePreparation(capture.id);
    for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready'); assert.equal(root.partsChainSha256, chain);
    job = await h.beginRestoreApply(job.id);
    for (let i = 0; job.state === 'deleting' && i < 100; i++) job = await h.advanceRestoreDeletion(job.id);
    for (let i = 0; ['awaiting_write', 'writing'].includes(job.state) && i < 100; i++) job = await h.advanceRestoreWriting(job.id);
    for (let i = 0; job.state === 'repairing_dates' && i < 100; i++) job = await h.advanceRestoreDateRepair(job.id);
    for (let i = 0; job.state === 'verifying' && i < 100; i++) job = await h.advanceRestoreVerification(job.id);
    assert.equal(job.state, 'completed'); const record = (await h.call('v3/sync/bootstrap')).body.records[0]; readSyncRecord(record);
    assert.equal(record.data.provider_links, '[]'); assert.equal(JSON.parse(record.data.source_links)[0].public_id, person.source.public_id);
  } finally { await h.close(); }
});

test('erasure removes saved provider facts and destroys operational authorization along with CRM data', async () => {
  const h = await createCloudHarness(); try {
    const { connection: c, preview } = await stagedGoogleContact(h); await importPerson(h, c, googleImportBody(preview));
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } }); assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal(await count(h, 'contact_provider_links'), 0); assert.equal(await count(h, 'contacts'), 0);
    assert.equal(await h.db.prepare('SELECT credentials FROM provider_connections WHERE id = ?').bind(c.id).first(), null);
  } finally { await h.close(); }
});
