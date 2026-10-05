import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { googleActor, googleEnvironment, stagedGoogleContact, googleImportBody } from './helpers/google-contact-fixture.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount, type NativeAccount } from '../packages/domain/src/devices.ts';
import { readBootstrap, readPull, readPushResult } from '../packages/domain/src/sync-client.ts';
import { MOBILE_SCHEMA_SQL, MOBILE_SYNC_MIGRATION_SQL, MOBILE_ENTITY_SYNC_MIGRATION_SQL } from '../apps/mobile/src/data/schema.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

async function authorizeAccount(cloud: Awaited<ReturnType<typeof createCloudHarness>>) {
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approval = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Test iPhone' });
  assert.equal(approval.status, 200);
  const code = parseDeviceCallback((await approval.json()).callback, state), token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const exchange = await cloud.exchangeDevice({ code, state, verifier, token });
  assert.equal(exchange.status, 200);
  return readNativeAccount({ ...(await exchange.json()).identity, origin: 'https://everclosecrm.com', token });
}

async function fixture() {
  const cloud = await createCloudHarness();
  await cloud.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.com', 1, 1, 1)`).run();
  await cloud.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  let account = await authorizeAccount(cloud);
  const mobile = await createMobileHarness(account);
  const requests: Array<{ path: string; body?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.origin, account.origin); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('Authorization'), `Bearer ${account.token}`);
    try { await cloud.deviceWorkspace(account.token); } catch { return Response.json({ error: 'Session revoked.' }, { status: 401 }); }
    const path = url.pathname.slice('/api/'.length) + url.search, body = init?.body as string | undefined;
    requests.push({ path, body });
    const response = await cloud.call(path, { method: init?.method, workspace: account.workspaceId, headers: { Authorization: headers.get('Authorization')! }, ...(body ? { body: JSON.parse(body) } : {}) });
    return Response.json(response.body, { status: response.status });
  };
  return { cloud, mobile, get account() { return account; }, async reauthorize() { account = await authorizeAccount(cloud); }, requests, fetcher, async close() { mobile.close(); await cloud.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test('Google source facts survive offline edits, schema-7 upgrades, older receipts and explicit unlink without becoming phone write payloads', async () => {
  const f = await fixture(); try {
    const contact = await webContact(f, 'My preferred name'); await run(f);
    const { connection, query } = await stagedGoogleContact(f.cloud); query.set('contact_id', String(contact.id));
    const preview = await f.cloud.contactImports.googleImportPreview(f.cloud.db, googleActor, connection.id, query);
    const imported = await f.cloud.contactImports.importGoogleContact(f.cloud.db, googleActor, googleEnvironment, connection.id,
      googleImportBody(preview, { contact_id: contact.id, create_name: null, expected_edit_revision: preview.target!.edit_revision }), crypto.randomUUID());
    await run(f);
    assert.equal(JSON.parse((await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!.provider_links!)[0].public_id, imported.source.public_id);
    await queuePatch(f, contact.public_id, { notes: 'Offline correction' });
    f.mobile.sqlite.exec('DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; DROP TABLE device_source_queue; ALTER TABLE contacts DROP COLUMN device_links; DROP TABLE device_contact_links; DROP TABLE device_contact_previews; ALTER TABLE contacts DROP COLUMN provider_links; PRAGMA user_version = 7;');
    await f.mobile.database.migrateDatabase(f.mobile.db);
    assert.equal(f.mobile.sqlite.pragma('user_version', { simple: true }), 16);
    assert.equal((await f.mobile.db.getFirstAsync("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'")), null);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 1);
    await run(f); let cached = (await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!;
    assert.equal(cached.notes, 'Offline correction'); assert.equal(cached.name, 'My preferred name'); assert.equal(JSON.parse(cached.provider_links!)[0].original_facts, imported.source.original_facts);
    await queuePatch(f, contact.public_id, { phone: '+351900000001' });
    await run(f, async (input, init) => { const response = await f.fetcher(input, init), body = await response.json(); if (body.result?.record?.data) delete body.result.record.data.provider_links; return Response.json(body, { status: response.status }); });
    cached = (await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!; assert.equal(JSON.parse(cached.provider_links!).length, 1);
    const pushes = f.requests.filter((r) => r.path.endsWith('/push')); assert.ok(pushes.every((r) => !JSON.stringify(JSON.parse(r.body!).mutation.patch).includes('provider_links')));
    await f.cloud.contactImports.unlinkProviderSource(f.cloud.db, googleActor, contact.id, imported.source.public_id, { expected_epoch: preview.epoch, expected_revision: 1 });
    await run(f); cached = (await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!;
    assert.equal(cached.provider_links, '[]'); assert.equal(cached.notes, 'Offline correction'); assert.equal(cached.phone, '+351900000001');
  } finally { await f.close(); }
});
test('linked source details reach the phone offline, retain edits and survive older receipts without reviving removed links', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f, 'My contact name'); await run(f);
    const linked = await f.cloud.call('sources/linkedin', { method: 'POST', body: { contact_id: contact.id, profile_url: 'linkedin.com/in/native-source', fields: { name: 'Source name', company: 'First company' } } });
    assert.equal(linked.status, 201, JSON.stringify(linked.body)); await run(f);
    const source = linked.body.source;
    const cached = await f.mobile.contacts.getContact(f.mobile.db, contact.public_id);
    assert.equal(JSON.parse(cached!.source_links!)[0].public_id, source.public_id);
    assert.equal(cached!.name, 'My contact name');
    await queuePatch(f, contact.public_id, { notes: 'Offline private note' });
    assert.equal((await f.cloud.call(`contacts/${contact.id}/sources/${source.public_id}`, { method: 'PATCH', body: { action: 'observe', expected_revision: 1, fields: { company: 'Second company' } } })).status, 200);
    await run(f);
    const changed = await f.mobile.contacts.getContact(f.mobile.db, contact.public_id);
    assert.equal(changed!.notes, 'Offline private note');
    assert.equal(JSON.parse(JSON.parse(changed!.source_links!)[0].fields).company.observed_value, 'Second company');
    await queuePatch(f, contact.public_id, { phone: '+351912345678' });
    await run(f, async (input, init) => {
      const response = await f.fetcher(input, init), body = await response.json();
      if (body.result?.record?.data) { delete body.result.record.data.source_links; delete body.result.record.data.source_revision; }
      return Response.json(body, { status: response.status });
    });
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!.source_links, changed!.source_links);
    assert.equal((await f.cloud.call(`contacts/${contact.id}/sources/${source.public_id}`, { method: 'DELETE', body: { expected_revision: 2 } })).status, 200);
    await run(f); assert.equal((await f.mobile.contacts.getContact(f.mobile.db, contact.public_id))!.source_links, '[]');
  } finally { await f.close(); }
});
async function webContact(f: Fixture, name = 'Ana') {
  const response = await f.cloud.call('contacts', { method: 'POST', body: { name, notes: 'From web' } });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.contact;
}
async function webEdit(f: Fixture, id: number, body: Record<string, unknown>) {
  const current = await f.cloud.call(`contacts/${id}`);
  const response = await f.cloud.call(`contacts/${id}`, { method: 'PATCH', body: { ...body, expected_edit_revision: current.body.contact.edit_revision } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
async function queuePatch(f: Fixture, id: string, patch: Record<string, string | number | null>) {
  await f.mobile.db.withExclusiveTransactionAsync(async (tx) => {
    const local = await tx.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM contacts WHERE id = ?', id);
    const raw = await tx.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_contacts WHERE id = ?', id);
    const fields = Object.keys(patch), base = Object.fromEntries(fields.map((key) => [key, local![key]]));
    await f.mobile.queue.enqueueSyncIntent(tx, 'contact', id, 'update', patch, new Date().toISOString(), { revision: raw ? JSON.parse(raw.record_json).revision : null, values: base });
    await tx.runAsync(`UPDATE contacts SET ${fields.map((key) => `${key} = ?`).join(', ')}, sync_state = 'pending' WHERE id = ?`, ...Object.values(patch), id);
  });
}
function run(f: Fixture, fetcher = f.fetcher) { return f.mobile.sync.syncContacts(f.mobile.db, f.account, { fetcher }); }
async function selectedPhoneSource(f: Fixture, options: { personId?: string; name?: string; share?: boolean; emails?: number[] } = {}) {
  const facts = { device_id: 'shared-phone-person', name: options.name ?? 'iPhone Ana',
    emails: [{ source_id: 'phone-email', value: 'shared-ana@example.test', label: 'Home' }], phones: [] };
  const id = await f.mobile.deviceContacts.stageDeviceContact(f.mobile.db, facts);
  const review = await f.mobile.deviceContacts.deviceContactReview(f.mobile.db, id, options.personId);
  const result = await f.mobile.deviceContacts.saveDeviceContactReview(f.mobile.db, id, {
    contact_id: options.personId ?? null, create_name: options.personId ? null : 'My Ana', use_name: false,
    emails: options.emails ?? [0], phones: [], expected_person: review.target ? f.mobile.deviceContacts.deviceImportContactRevision(review.target) : null,
    expected_source_revision: review.link?.revision ?? null, publish_source: options.share ?? true,
  });
  return { ...result, source: (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, result.contact_id))[0], facts };
}

test('consented iPhone source publication waits for accepted person fields and becomes read-only provenance on another phone', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 2);
    await run(f);
    const writes = f.requests.filter((r) => r.path.endsWith('/push'));
    assert.deepEqual(writes.map((r) => r.path), ['v4/sync/push', 'v1/device-sources/push']);
    assert.ok(!writes[0].body!.includes('shared-phone-person')); assert.ok(writes[1].body!.includes('shared-phone-person'));
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    const sources = await f.mobile.deviceSourceSync.savedDeviceSources(f.mobile.db, saved.contact_id);
    assert.equal(sources.length, 1); assert.equal(sources[0].fromThisPhone, true); assert.equal(sources[0].cloud_revision, 1);
    const another = await createMobileHarness(f.account);
    try {
      await another.sync.syncWorkspace(another.db, f.account, { fetcher: f.fetcher });
      const readOnly = await another.deviceSourceSync.savedDeviceSources(another.db, saved.contact_id);
      assert.equal(readOnly.length, 1); assert.equal(readOnly[0].fromThisPhone, false); assert.equal(readOnly[0].hasLocalLink, false); assert.equal(readOnly[0].original_facts, saved.source.original_facts);
      assert.deepEqual(await another.deviceContacts.listDeviceContactLinks(another.db, saved.contact_id), []);
      const preview = await another.deviceContacts.stageDeviceContact(another.db, saved.facts);
      assert.equal((await another.deviceContacts.deviceContactReview(another.db, preview)).link, null);
      await another.deviceSourceSync.unlinkSharedDeviceSource(another.db, readOnly[0]);
      await another.sync.syncWorkspace(another.db, f.account, { fetcher: f.fetcher }); await run(f);
      assert.deepEqual(await f.mobile.deviceSourceSync.savedDeviceSources(f.mobile.db, saved.contact_id), []);
      assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.email, 'shared-ana@example.test');
    } finally { another.close(); }
  } finally { await f.close(); }
});

test('recurring iPhone observations survive lost cloud replies, protect web corrections and never grant another phone reading consent', async () => {
  const f = await fixture();
  try {
    await run(f); const saved = await selectedPhoneSource(f); await run(f);
    async function choices(reset: string[] = []) {
      const review = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id);
      return { expected_policy_revision: review.policy.revision, expected_source_revision: review.source.revision, expected_person: review.personRevision,
        enabled: true, name: 'keep' as const, methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: 'follow' as const })), reset };
    }
    await f.mobile.deviceReconciliation.changeDevicePolicy(f.mobile.db, saved.source.id, await choices());
    const [intent] = await f.mobile.deviceReconciliation.nextDeviceReads(f.mobile.db, saved.source.id); assert.ok(intent);
    const observed = { ...saved.facts, emails: [{ ...saved.facts.emails[0], value: 'new-iphone@example.test' }] };
    assert.equal(await f.mobile.deviceReconciliation.commitDeviceRead(f.mobile.db, intent, { state: 'available', facts: observed }), true);
    const initialRevision = (await f.cloud.db.prepare('SELECT revision FROM contact_device_links WHERE public_id = ?').bind(saved.source.id).first<{ revision: number }>())!.revision;
    await assert.rejects(run(f, async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/device-sources/push')) throw new Error('Lost recurring source reply'); return response; }));
    const frozen = f.mobile.sqlite.prepare('SELECT request_json FROM device_source_queue WHERE source_id = ?').get(saved.source.id)!.request_json;
    await run(f);
    assert.equal(f.requests.filter((request) => request.path === 'v1/device-sources/push').at(-1)!.body, frozen);
    const serverSource = (await f.cloud.db.prepare('SELECT * FROM contact_device_links WHERE public_id = ?').bind(saved.source.id).first<{ revision: number; observed_facts: string; original_facts: string }>())!;
    assert.equal(serverSource.revision, initialRevision + 1); assert.equal(serverSource.original_facts, saved.source.original_facts); assert.equal(JSON.parse(serverSource.observed_facts).emails[0].value, 'new-iphone@example.test');
    const person = (await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!;
    await webEdit(f, person.remote_id!, { name: 'My web name', email: 'my-web-correction@example.test', notes: 'Keep private web history' }); await run(f);
    const [next] = await f.mobile.deviceReconciliation.nextDeviceReads(f.mobile.db, saved.source.id); assert.ok(next);
    assert.equal(await f.mobile.deviceReconciliation.commitDeviceRead(f.mobile.db, next, { state: 'available', facts: { ...observed, name: 'New OS name', emails: [{ ...observed.emails[0], value: 'later-iphone@example.test' }] } }), true); await run(f);
    const corrected = (await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!;
    assert.equal(corrected.name, 'My web name'); assert.equal(corrected.email, 'my-web-correction@example.test'); assert.equal(corrected.notes, 'Keep private web history');
    const review = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id); assert.equal(review.fields.methods[0].overridden, true);
    await f.mobile.deviceReconciliation.changeDevicePolicy(f.mobile.db, saved.source.id, await choices([review.fields.methods[0].id])); await run(f);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.email, 'later-iphone@example.test');
    const another = await createMobileHarness(f.account);
    try {
      await another.sync.syncWorkspace(another.db, f.account, { fetcher: f.fetcher });
      assert.equal((await another.contacts.getContact(another.db, saved.contact_id))!.email, 'later-iphone@example.test');
      assert.equal((await another.deviceSourceSync.savedDeviceSources(another.db, saved.contact_id))[0].fromThisPhone, false);
      assert.deepEqual(await another.deviceReconciliation.nextDeviceReads(another.db), []);
      assert.equal(another.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_policies').get().n, 0);
    } finally { another.close(); }
  } finally { await f.close(); }
});

test('a lost iPhone source reply survives restart and reauthorization with the exact request and installation identity', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f), installation = await f.mobile.deviceSourceSync.installationId(f.mobile.db);
    const lose: typeof fetch = async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/device-sources/push')) throw new Error('Lost source reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = f.mobile.sqlite.prepare('SELECT request_json FROM device_source_queue').get().request_json;
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contact_device_links').first())!.n, 1);
    await assert.rejects(f.mobile.deviceSourceSync.discardDeviceSourceUploads(f.mobile.db, saved.source.id), /uncertain source save/);
    await f.reauthorize(); const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    assert.equal(await restarted.deviceSourceSync.installationId(restarted.db), installation);
    await restarted.sync.syncWorkspace(restarted.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.requests.filter((r) => r.path === 'v1/device-sources/push').at(-1)!.body, frozen);
    assert.equal((await restarted.sync.syncSummary(restarted.db)).pending, 0);
    assert.equal((await f.cloud.db.prepare('SELECT revision FROM contact_device_links').first())!.revision, 1);
  } finally { await f.close(); }
});

test('ordered source observations and unlink keep their dependencies after an uncertain publication', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f);
    await assert.rejects(run(f, async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/device-sources/push')) throw new Error('Unknown source outcome'); return response; }));
    const frozen = f.mobile.sqlite.prepare('SELECT request_json FROM device_source_queue').get().request_json;
    const updated = await selectedPhoneSource(f, { personId: saved.contact_id, name: 'Changed on iPhone', emails: [] });
    await f.mobile.deviceContacts.unlinkDeviceContact(f.mobile.db, updated.source);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 3); await run(f);
    const requests = f.requests.filter((r) => r.path === 'v1/device-sources/push').slice(-3).map((r) => JSON.parse(r.body!));
    assert.equal(JSON.stringify(requests[0]), frozen); assert.deepEqual(requests.map((r) => r.expected_revision), [null, 1, 2]);
    assert.deepEqual(requests.map((r) => r.action), ['publish', 'publish', 'unlink']);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0); assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contact_device_links').first())!.n, 0);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.name, 'My Ana');
  } finally { await f.close(); }
});

test('source sharing is explicit for a private local review and source-queue failure rolls back only the attempted change', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f, { share: false }); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contact_device_links').first())!.n, 0);
    f.mobile.faults.sqlContains = 'INSERT INTO device_source_queue';
    await assert.rejects(f.mobile.deviceContacts.shareDeviceContact(f.mobile.db, saved.source), /database write failure/);
    assert.equal((await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0].shared, 0);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0); delete f.mobile.faults.sqlContains;
    await f.mobile.deviceContacts.shareDeviceContact(f.mobile.db, saved.source); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contact_device_links').first())!.n, 1);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.email, 'shared-ana@example.test');
  } finally { await f.close(); }
});

test('an old acknowledgement without device-source fields preserves the current cache and explicit removal never removes accepted data', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f); await run(f);
    const current = (await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!;
    await queuePatch(f, saved.contact_id, { notes: 'Private memory' });
    await run(f, async (url, init) => { const response = await f.fetcher(url, init), body = await response.json(); if (body.result?.record?.data) delete body.result.record.data.device_links; return Response.json(body, { status: response.status }); });
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.device_links, current.device_links);
    const source = (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0];
    await f.mobile.deviceContacts.unlinkDeviceContact(f.mobile.db, source); await run(f);
    const person = (await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!;
    assert.equal(person.device_links, '[]'); assert.equal(person.notes, 'Private memory'); assert.equal(person.contact_methods, current.contact_methods);
  } finally { await f.close(); }
});

test('restoration holds old source uploads for review and discarding them retains accepted contact methods', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f); await run(f);
    const opening = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id);
    await f.mobile.deviceReconciliation.changeDevicePolicy(f.mobile.db, saved.source.id, { expected_policy_revision: opening.policy.revision,
      expected_source_revision: opening.source.revision, expected_person: opening.personRevision, enabled: true, name: 'keep',
      methods: opening.fields.methods.map((rule) => ({ id: rule.id, mode: 'follow' })), reset: [] });
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    await selectedPhoneSource(f, { personId: saved.contact_id, name: 'Pending new source name', emails: [] });
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    await run(f); const conflicts = await f.mobile.deviceSourceSync.deviceSourceSyncReviews(f.mobile.db);
    assert.equal(conflicts.length, 1); assert.equal(conflicts[0].last_error_code, 'epoch_changed');
    await f.mobile.deviceSourceSync.discardDeviceSourceUploads(f.mobile.db, saved.source.id);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
    const local = (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0];
    assert.equal(JSON.parse(local.observed_facts).name, 'iPhone Ana');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.email, 'shared-ana@example.test');
    assert.equal(f.requests.filter((r) => r.path === 'v1/device-sources/push').length, 1);
    const paused = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id);
    assert.equal(paused.policy.enabled, 0); assert.equal(paused.policy.reason, 'restored');
    assert.deepEqual(await f.mobile.deviceReconciliation.nextDeviceReads(f.mobile.db, saved.source.id), []);
  } finally { await f.close(); }
});

test('a source receipt retries against a merged person and never replaces the survivor’s private history', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f);
    await assert.rejects(run(f, async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/device-sources/push')) throw new Error('Lost source receipt'); return response; }));
    const opening = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id);
    await f.mobile.deviceReconciliation.changeDevicePolicy(f.mobile.db, saved.source.id, { expected_policy_revision: opening.policy.revision,
      expected_source_revision: opening.source.revision, expected_person: opening.personRevision, enabled: true, name: 'keep',
      methods: opening.fields.methods.map((rule) => ({ id: rule.id, mode: 'follow' })), reset: [] });
    const original = (await f.cloud.db.prepare('SELECT id FROM contacts WHERE public_id = ?').bind(saved.contact_id).first())!;
    const survivor = await webContact(f, 'Survivor'); await webEdit(f, survivor.id, { email: 'shared-ana@example.test' }); const review = await f.cloud.call('contacts/duplicates');
    const merge = await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: survivor.id, duplicateIds: [original.id], expectedRevision: review.body.revision } });
    assert.equal(merge.status, 200, JSON.stringify(merge.body)); await run(f);
    const source = (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0];
    assert.equal(source.contact_id, survivor.public_id); assert.equal(source.cloud_revision, 1);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, saved.contact_id))!.notes, 'From web');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    const paused = await f.mobile.deviceReconciliation.devicePolicyReview(f.mobile.db, saved.source.id);
    assert.equal(paused.policy.enabled, 0); assert.equal(paused.policy.reason, 'merged');
    assert.deepEqual(await f.mobile.deviceReconciliation.nextDeviceReads(f.mobile.db, saved.source.id), []);
  } finally { await f.close(); }
});

test('an existing cloud OS identity does not overwrite a distinct private phone review or abort replica refresh', async () => {
  const f = await fixture(); try {
    await run(f); const saved = await selectedPhoneSource(f); await run(f);
    // Represent a separate local review with this installation's same OS ID and a different UUID.
    f.mobile.sqlite.prepare('UPDATE device_contact_links SET id = ?, shared = 0, cloud_revision = NULL').run(crypto.randomUUID());
    const privateSource = (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0];
    f.mobile.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run(); await run(f);
    const sources = await f.mobile.deviceSourceSync.savedDeviceSources(f.mobile.db, saved.contact_id); assert.equal(sources.length, 2);
    assert.equal(sources.find((source) => source.id === saved.source.id)!.hasLocalLink, false); assert.equal(sources.find((source) => source.id === privateSource.id)!.hasLocalLink, true);
    assert.equal((await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0].id, privateSource.id);
    await f.mobile.deviceContacts.shareDeviceContact(f.mobile.db, privateSource); await run(f);
    const conflicts = await f.mobile.deviceSourceSync.deviceSourceSyncReviews(f.mobile.db); assert.equal(conflicts[0].last_error_code, 'source_changed');
    await f.mobile.deviceSourceSync.discardDeviceSourceUploads(f.mobile.db, privateSource.id);
    assert.equal((await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, saved.contact_id))[0].shared, 0);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contact_device_links').first())!.n, 1);
  } finally { await f.close(); }
});
test('reviewed iPhone capture reaches web once after a lost reply while source details remain on the choosing phone', async () => {
  const f = await fixture();
  try {
    await run(f);
    const facts = { device_id: 'selected-iphone-contact', name: 'iPhone Ana',
      emails: [{ source_id: 'os-email', value: 'iphone-ana@example.test', label: 'Home' }], phones: [] };
    const id = await f.mobile.deviceContacts.stageDeviceContact(f.mobile.db, facts);
    const input = { contact_id: null, create_name: 'My Ana', use_name: false, emails: [0], phones: [], expected_person: null, expected_source_revision: null };
    const person = await f.mobile.deviceContacts.saveDeviceContactReview(f.mobile.db, id, input);
    const methods = (await f.mobile.contacts.getContact(f.mobile.db, person.contact_id))!.contact_methods;
    const lose: typeof fetch = async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/push')) throw new Error('Lost iPhone save reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue').get().request_json;
    const server = (await f.cloud.db.prepare('SELECT id FROM contacts WHERE public_id = ?').bind(person.contact_id).first())!;
    await webEdit(f, Number(server.id), { notes: 'New private web memory' });
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    assert.deepEqual(await restarted.deviceContacts.saveDeviceContactReview(restarted.db, id, input), person);
    await restarted.sync.syncWorkspace(restarted.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.requests.filter((r) => r.path.endsWith('/push')).at(-1)!.body, frozen);
    const cloudPerson = (await f.cloud.call(`contacts/${server.id}`)).body.contact;
    assert.equal(cloudPerson.name, 'My Ana'); assert.equal(cloudPerson.notes, 'New private web memory'); assert.equal(cloudPerson.contact_methods, methods);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM contacts WHERE public_id = ?').bind(person.contact_id).first())!.n, 1);
    const local = (await restarted.contacts.getContact(restarted.db, person.contact_id))!; assert.equal(local.notes, cloudPerson.notes);
    assert.deepEqual(JSON.parse((await restarted.deviceContacts.listDeviceContactLinks(restarted.db, person.contact_id))[0].original_facts), facts);
    assert.equal(JSON.stringify(JSON.parse(frozen).mutation.data).includes('selected-iphone-contact'), false);
    assert.equal(JSON.stringify(JSON.parse(frozen).mutation.data).includes('source_id'), false);
    const anotherPhone = await createMobileHarness(f.account);
    try {
      await anotherPhone.sync.syncWorkspace(anotherPhone.db, f.account, { fetcher: f.fetcher });
      assert.equal((await anotherPhone.contacts.getContact(anotherPhone.db, person.contact_id))!.contact_methods, methods);
      assert.deepEqual(await anotherPhone.deviceContacts.listDeviceContactLinks(anotherPhone.db, person.contact_id), []);
    } finally { anotherPhone.close(); }
  } finally { await f.close(); }
});
test('reviewed iPhone attachment and source receipts follow a cloud merge without replacing private history or preferred methods', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const id = await f.mobile.deviceContacts.stageDeviceContact(f.mobile.db, { device_id: 'merge-device-source', name: 'Device title',
      emails: [{ source_id: null, value: 'new-work@example.test', label: 'Work' }], phones: [] });
    const review = await f.mobile.deviceContacts.deviceContactReview(f.mobile.db, id, b.public_id);
    const input = { contact_id: b.public_id, create_name: null, use_name: false, emails: [0], phones: [],
      expected_person: f.mobile.deviceContacts.deviceImportContactRevision(review.target!), expected_source_revision: null };
    await f.mobile.deviceContacts.saveDeviceContactReview(f.mobile.db, id, input); await run(f);
    const source = (await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, b.public_id))[0];
    await webMerge(f, a.id, [b.id]); await run(f);
    const links = await f.mobile.deviceContacts.listDeviceContactLinks(f.mobile.db, b.public_id);
    assert.equal(links.length, 1); assert.equal(links[0].id, source.id); assert.equal(links[0].contact_id, a.public_id);
    assert.equal(links[0].original_facts, source.original_facts);
    assert.deepEqual(await f.mobile.deviceContacts.saveDeviceContactReview(f.mobile.db, id, input), { contact_id: a.public_id });
    const saved = await f.mobile.deviceContacts.deviceContactReview(f.mobile.db, id);
    assert.equal(saved.saved?.id, a.public_id); assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    const person = (await f.cloud.call(`contacts/${a.id}`)).body.contact;
    assert.equal(person.name, 'Ana'); assert.equal(person.notes, 'From web'); assert.equal(person.email, 'ana@example.test');
    assert.ok(JSON.parse(person.contact_methods).some((method: { value: string }) => method.value === 'new-work@example.test'));
  } finally { await f.close(); }
});
async function duplicatePeople(f: Fixture) {
  const a = await webContact(f, 'Ana'), b = await webContact(f, 'Ana mobile');
  for (const contact of [a, b]) await webEdit(f, contact.id, { email: 'ana@example.test' });
  await run(f); return { a, b };
}
async function webMerge(f: Fixture, primary: number, duplicates: number[]) {
  const review = await f.cloud.call('contacts/duplicates');
  const response = await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: primary, duplicateIds: duplicates, expectedRevision: review.body.revision } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

const planDraft = { type: 'meetup', planned_date: '2026-10-05', summary: 'Lunch', notes: 'Bring the book' };
async function nativePlan(f: Fixture, contactId: string) { return f.mobile.context.createContext(f.mobile.db, 'plan', contactId, planDraft); }

test('phone capture reaches the cloud once and later web edits return with the same UUID', async () => {
  const f = await fixture();
  try {
    const local = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Ana', email: 'ana@example.com', notes: 'Phone note', deviceContactId: 'private-device-id' });
    await run(f);
    const server = await f.cloud.db.prepare('SELECT * FROM contacts').first();
    assert.equal(server?.public_id, local.id); assert.equal(server?.email, 'ana@example.com');
    assert.equal(f.requests.find((request) => request.body)?.body?.includes('private-device-id'), false);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    await webEdit(f, Number(server!.id), { notes: 'Edited on web' });
    await run(f);
    const downloaded = await f.mobile.contacts.getContact(f.mobile.db, local.id);
    assert.equal(downloaded?.notes, 'Edited on web'); assert.equal(downloaded?.remote_id, server!.id); assert.equal(downloaded?.sync_state, 'synced');
  } finally { await f.close(); }
});

test('a lost create response survives an app restart and retries the exact persisted operation', async () => {
  const f = await fixture();
  try {
    const local = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Ana', notes: 'Offline' });
    let lost = false;
    const lose: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      if (String(input).endsWith('/push') && !lost) { lost = true; throw new Error('Response lost after commit'); }
      return response;
    };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue WHERE entity_type = ?').get('contact') as { request_json: string };
    assert.equal(JSON.parse(frozen.request_json).mutation.entityId, local.id);
    await f.cloud.db.prepare("UPDATE contacts SET notes = 'Later web edit' WHERE public_id = ?").bind(local.id).run();
    // Load new client modules on the same persisted database, as a restarted app would.
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    await restarted.sync.syncContacts(restarted.db, f.account, { fetcher: f.fetcher });
    const pushed = f.requests.filter((request) => request.path.endsWith('/push'));
    assert.equal(pushed.length, 2); assert.equal(pushed[0].body, pushed[1].body);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) AS count FROM contacts').first())?.count, 1);
    assert.equal((await restarted.contacts.getContact(restarted.db, local.id))?.notes, 'Later web edit');
    assert.equal((await restarted.sync.syncSummary(restarted.db)).pending, 0);
  } finally { await f.close(); }
});

test('an interrupted bootstrap keeps the existing cache and commits all downloaded pages only at the end', async () => {
  const f = await fixture();
  try {
    const first = await webContact(f, 'Existing'); await run(f);
    const original = f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts WHERE deleted_at IS NULL').get() as { count: number };
    for (let index = 0; index < 13; index++) await webContact(f, `New ${index}`);
    f.mobile.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run();
    let downloads = 0;
    const interrupt: typeof fetch = async (input, init) => {
      if (String(input).includes('/bootstrap') && ++downloads === 2) throw new Error('Network interrupted');
      return f.fetcher(input, init);
    };
    await assert.rejects(run(f, interrupt), /Offline changes are safe/);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts WHERE deleted_at IS NULL').get() as { count: number }).count, original.count);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, String((await f.cloud.db.prepare('SELECT public_id FROM contacts WHERE id = ?').bind(first.id).first())?.public_id)))?.name, 'Existing');
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), undefined);
    await run(f);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts WHERE deleted_at IS NULL').get() as { count: number }).count, 14);
  } finally { await f.close(); }
});

test('bootstrap rejects a changed page set without publishing a partial replica', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 12; index++) await webContact(f, `Person ${index}`);
    let pages = 0;
    const changing: typeof fetch = async (input, init) => {
      if (String(input).includes('/bootstrap') && ++pages === 2) await webContact(f, 'Concurrent web capture');
      return f.fetcher(input, init);
    };
    await assert.rejects(run(f, changing), /changed/);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 0);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor'").get(), undefined);
    await run(f);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 13);
  } finally { await f.close(); }
});

test('capture and repeated touches queue in order before first sync while their local history is retained', async () => {
  const f = await fixture();
  try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Captured offline' });
    await f.mobile.contacts.logInteraction(f.mobile.db, person.id, 'call');
    await f.mobile.contacts.logInteraction(f.mobile.db, person.id, 'meetup');
    const results = await Promise.all([run(f), run(f)]);
    assert.deepEqual(results[0], results[1]);
    const requests = f.requests.filter((request) => request.body).map((request) => JSON.parse(request.body!));
    assert.deepEqual(requests.map((request) => request.mutation.type), ['create', 'create', 'create']);
    assert.deepEqual(requests.map((request) => request.mutation.entity), ['contact', 'interaction', 'interaction']);
    assert.equal(new Set(requests.map((request) => request.mutation.operationId)).size, 3);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).phoneOnly, 0);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM interactions').first())?.count, 2);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, person.id)).length, 2);
    assert.equal((await f.cloud.db.prepare('SELECT last_contacted FROM contacts WHERE public_id = ?').bind(person.id).first())?.last_contacted, new Date().toISOString().slice(0, 10));
  } finally { await f.close(); }
});

test('pull applies a page and its cursor in one transaction and a local failure can retry the page', async () => {
  const f = await fixture();
  try {
    await webContact(f); await run(f);
    const before = (f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor'").get() as { value: string }).value;
    await webContact(f, 'Second'); f.mobile.faults.sqlContains = 'INSERT INTO app_metadata';
    await assert.rejects(run(f), /Simulated local database/);
    assert.equal((f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor'").get() as { value: string }).value, before);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 1);
    delete f.mobile.faults.sqlContains; await run(f);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 2);
  } finally { await f.close(); }
});

test('disjoint offline edits merge and overlapping edits retain a reviewable phone draft', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const local = f.mobile.sqlite.prepare('SELECT id FROM contacts').get() as { id: string };
    await queuePatch(f, local.id, { notes: 'Offline note' });
    await webEdit(f, contact.id, { email: 'new@example.com' });
    await run(f);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, local.id))?.email, 'new@example.com');
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(contact.id).first())?.notes, 'Offline note');
    await queuePatch(f, local.id, { notes: 'Second offline note' });
    await webEdit(f, contact.id, { notes: 'Overlapping web note' });
    await run(f);
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    assert.equal(review.local.notes, 'Second offline note'); assert.equal(review.cloud?.data?.notes, 'Overlapping web note');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, local.id))?.sync_state, 'conflict');
    await queuePatch(f, local.id, { phone: '+351 123456789' });
    await assert.rejects(f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'phone'), /review changed/);
    const [updatedReview] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, updatedReview, 'phone'); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(contact.id).first())?.notes, 'Second offline note');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('a phone form keeps its opening base and edits only changed fields when web updates arrive while it is open', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const id = (f.mobile.sqlite.prepare('SELECT id FROM contacts').get() as { id: string }).id;
    const original = (await f.mobile.contacts.getContactForEditing(f.mobile.db, id))!;
    assert.equal(original.remote_revision, 1);
    const draft = { name: original.name, email: original.email, phone: original.phone, notes: 'Edited in phone form', contactFrequency: original.contact_frequency };
    await webEdit(f, contact.id, { email: 'arrived-while-open@example.com' }); await run(f);
    await f.mobile.contacts.updateContact(f.mobile.db, original, draft);
    const pending = f.mobile.sqlite.prepare("SELECT payload, base_payload FROM sync_queue WHERE entity_type = 'contact'").get() as { payload: string; base_payload: string };
    assert.deepEqual(JSON.parse(pending.payload), { notes: 'Edited in phone form' });
    assert.deepEqual(JSON.parse(pending.base_payload), { notes: 'From web' });
    await run(f);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, id))?.email, 'arrived-while-open@example.com');
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(contact.id).first())?.notes, 'Edited in phone form');
    const second = (await f.mobile.contacts.getContactForEditing(f.mobile.db, id))!;
    await webEdit(f, contact.id, { notes: 'Changed on web while editing' }); await run(f);
    await f.mobile.contacts.updateContact(f.mobile.db, second, { ...draft, email: second.email, notes: 'Second phone edit' }); await run(f);
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    assert.equal(review.local.notes, 'Second phone edit'); assert.equal(review.cloud?.data?.notes, 'Changed on web while editing');
  } finally { await f.close(); }
});

test('editing a newly captured offline person sends creation before the edit and a no-op save does not queue an operation', async () => {
  const f = await fixture();
  try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Original capture' });
    const base = (await f.mobile.contacts.getContactForEditing(f.mobile.db, person.id))!;
    const draft = { name: base.name, email: base.email, phone: base.phone, notes: base.notes, contactFrequency: base.contact_frequency };
    await f.mobile.contacts.updateContact(f.mobile.db, base, draft);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 1);
    await assert.rejects(f.mobile.contacts.updateContact(f.mobile.db, base, { ...draft, email: 'not-an-address' }), /valid email/);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 1);
    await f.mobile.contacts.updateContact(f.mobile.db, base, { ...draft, name: 'Updated before sync', notes: 'Remember this' });
    await run(f);
    const sent = f.requests.filter((request) => request.body).map((request) => JSON.parse(request.body!));
    assert.deepEqual(sent.map((request) => request.mutation.type), ['create', 'update']);
    assert.equal((await f.cloud.db.prepare('SELECT name FROM contacts WHERE public_id = ?').bind(person.id).first())?.name, 'Updated before sync');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
  } finally { await f.close(); }
});

test('a response that arrives after account switching cannot replace the old cache or its cursor', async () => {
  const f = await fixture();
  try {
    await webContact(f); let active = true;
    const late: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init); active = false; return response;
    };
    await assert.rejects(f.mobile.sync.syncContacts(f.mobile.db, f.account, { fetcher: late, isCurrent: () => active }), /active account changed/);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 0);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor'").get(), undefined);
    await run(f);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 1);
  } finally { await f.close(); }
});

test('restore changes epoch without replaying an old offline edit into the restored dataset', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const snapshot = await f.cloud.call('settings/backups', { method: 'POST' }); assert.equal(snapshot.status, 201);
    const local = f.mobile.sqlite.prepare('SELECT id FROM contacts').get() as { id: string };
    await queuePatch(f, local.id, { notes: 'Old offline edit' });
    await webEdit(f, contact.id, { notes: 'Before restore' });
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: snapshot.body.backup.filename, confirmation: 'RESTORE' } })).status, 200);
    await run(f);
    assert.equal(f.requests.filter((request) => request.body).length, 0);
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(contact.id).first())?.notes, 'From web');
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    assert.equal(review.reason, 'epoch_changed'); assert.equal(review.local.notes, 'Old offline edit');
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'cloud');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, local.id))?.notes, 'From web');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('revoked or changed accounts do not upload and an erased workspace never receives an old phone draft', async () => {
  const f = await fixture();
  try {
    await webContact(f); await run(f);
    const local = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Offline new person' });
    await assert.rejects(f.mobile.sync.syncContacts(f.mobile.db, { ...f.account, workspaceId: 'other' }, { fetcher: f.fetcher }), /another account/);
    await assert.rejects(f.mobile.sync.syncContacts(f.mobile.db, f.account, { fetcher: f.fetcher, isCurrent: () => false }), /active account changed/);
    assert.equal(f.requests.filter((request) => request.body).length, 0);
    const erased = await f.cloud.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } });
    assert.equal(erased.status, 200); await assert.rejects(run(f), /Sign in again/);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, local.id))?.name, 'Offline new person');
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM contacts').first())?.count, 0);
    await f.reauthorize(); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM contacts').first())?.count, 0);
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    assert.equal(review.contactId, local.id);
    assert.equal(review.reason, 'epoch_changed');
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const copied = await f.cloud.db.prepare('SELECT public_id, name FROM contacts').first();
    assert.equal(copied?.name, 'Offline new person'); assert.notEqual(copied?.public_id, local.id);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('a cloud contact deletion retains unsent interactions and reminders instead of cascading them away', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const local = f.mobile.sqlite.prepare('SELECT id FROM contacts').get() as { id: string };
    await f.mobile.contacts.logInteraction(f.mobile.db, local.id, 'call');
    await f.mobile.reminders.createReminder(f.mobile.db, { contactId: local.id, title: 'Offline reminder', remindAt: new Date(Date.now() + 86400000), notes: '' }, null);
    const removed = await f.cloud.call(`contacts/${contact.id}`, { method: 'DELETE' }); assert.equal(removed.status, 200);
    await run(f);
    assert.equal(await f.mobile.contacts.getContact(f.mobile.db, local.id), null);
    assert.equal((f.mobile.sqlite.prepare('SELECT COUNT(*) count FROM interactions').get() as { count: number }).count, 1);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 2);
    assert.equal((await f.mobile.sync.contactSyncReviews(f.mobile.db)).length, 1);
    assert.equal((await f.mobile.sync.childSyncReviews(f.mobile.db)).length, 2);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM interactions').first())?.count, 0);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0];
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'copy'); await run(f);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
    const copied = await f.cloud.db.prepare('SELECT public_id FROM contacts').first();
    assert.notEqual(copied?.public_id, local.id);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM interactions').first())?.count, 1);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM reminders').first())?.count, 1);
  } finally { await f.close(); }
});

test('a version-1 phone database upgrades without losing local-only people, history or queued intent', async () => {
  const sqlite = new Database(':memory:'); sqlite.exec(MOBILE_SCHEMA_SQL); sqlite.pragma('user_version = 1');
  const id = crypto.randomUUID(), now = new Date().toISOString();
  sqlite.prepare('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, 'Before upgrade', now, now);
  sqlite.prepare("INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at) VALUES (?, 'contact', ?, 'create', ?, ?)").run(crypto.randomUUID(), id, JSON.stringify({ name: 'Before upgrade' }), now);
  const account = { deviceId: crypto.randomUUID(), workspaceId: 'test', userId: 'owner', email: 'me@example.com', name: 'Me', origin: 'https://everclosecrm.com', token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`, expiresAt: '2030-01-01T00:00:00Z' } satisfies NativeAccount;
  const mobile = await createMobileHarness(account, sqlite);
  try {
    assert.equal(sqlite.pragma('user_version', { simple: true }), 16);
    assert.equal((await mobile.contacts.getContact(mobile.db, id))?.name, 'Before upgrade');
    assert.equal((await mobile.sync.syncSummary(mobile.db)).pending, 1);
    await mobile.database.migrateDatabase(mobile.db); assert.equal((await mobile.sync.syncSummary(mobile.db)).pending, 1);
  } finally { mobile.close(); }
});

test('native sync rejects unsupported or mismatched server responses before applying them', () => {
  const cursor = { epoch: crypto.randomUUID(), sequence: 3 };
  assert.throws(() => readBootstrap({ version: 2, entities: ['contact'], cursor, records: [], next: null }), /invalid sync/);
  assert.throws(() => readBootstrap({ version: 1, entities: ['contact'], cursor, records: [], next: { ...cursor, after: crypto.randomUUID() } }), /invalid sync/);
  assert.throws(() => readPull({ version: 1, changes: [], more: true, cursor }, cursor), /invalid sync/);
  assert.throws(() => readPushResult({ version: 1, replayed: false, result: { operationId: crypto.randomUUID(), status: 'applied', record: null } }, crypto.randomUUID(), crypto.randomUUID()), /invalid sync/);
});

test('web history with a date only and web reminder completion converge without invented activity times', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f);
    const history = (await f.cloud.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: '2026-10-01', type: 'email', summary: 'Earlier email' } })).body.interaction;
    const reminder = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Web reminder', remind_at: '2030-01-01T10:00:00Z' } })).body.reminder;
    await run(f);
    const local = await f.mobile.contacts.listContactInteractions(f.mobile.db, contact.public_id);
    assert.equal(local[0].id, history.public_id); assert.equal(local[0].date, '2026-10-01'); assert.equal(local[0].occurred_at, null);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db))[0].id, reminder.public_id);
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { completed: true } });
    await run(f);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 0);
    assert.ok((f.mobile.sqlite.prepare('SELECT completed_at FROM reminders WHERE id = ?').get(reminder.public_id) as { completed_at: string }).completed_at);
  } finally { await f.close(); }
});

test('an offline reminder can complete before its first acknowledgement and later completion merges around a web title edit', async () => {
  const f = await fixture();
  try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Offline' });
    const draft = await f.mobile.reminders.createReminder(f.mobile.db, { contactId: person.id, title: 'Offline reminder', remindAt: new Date(Date.now() + 86400000) }, 'scheduled-local');
    assert.equal(await f.mobile.reminders.completeReminder(f.mobile.db, draft.id), 'scheduled-local');
    assert.equal(await f.mobile.reminders.completeReminder(f.mobile.db, draft.id), null);
    await run(f);
    const completed = await f.cloud.db.prepare('SELECT * FROM reminders WHERE public_id = ?').bind(draft.id).first();
    assert.ok(completed?.completed_at); assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    const next = await f.mobile.reminders.createReminder(f.mobile.db, { contactId: person.id, title: 'Another reminder', remindAt: new Date(Date.now() + 172800000) }, null);
    await run(f);
    const current = await f.cloud.db.prepare('SELECT * FROM reminders WHERE public_id = ?').bind(next.id).first();
    await f.mobile.reminders.completeReminder(f.mobile.db, next.id);
    await f.cloud.call(`reminders/${current!.id}`, { method: 'PATCH', body: { title: 'Web title', notes: null, remind_at: current!.remind_at } });
    await run(f);
    const result = await f.cloud.db.prepare('SELECT * FROM reminders WHERE public_id = ?').bind(next.id).first();
    assert.equal(result?.title, 'Web title'); assert.ok(result?.completed_at);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('snooze retries its frozen reply after restart and a second offline time preserves a concurrent web title', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f);
    const reminder = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: person.id,
      title: 'Original reminder', notes: 'Private reminder context', remind_at: '2030-01-01T10:00:00Z' } })).body.reminder;
    await run(f);
    const [shown] = await f.mobile.reminders.listOpenReminders(f.mobile.db);
    const moved = await f.mobile.reminders.snoozeReminder(f.mobile.db, shown, new Date('2030-01-02T10:00:00Z'));
    await assert.rejects(run(f, async (input, init) => {
      const response = await f.fetcher(input, init);
      if (String(input).endsWith('/push')) throw new Error('Lost snooze reply after commit');
      return response;
    }), /Offline changes are safe/);
    const frozen = f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'reminder' AND request_json IS NOT NULL").get().request_json;
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    await restarted.reminders.snoozeReminder(restarted.db, moved.reminder, new Date('2030-01-07T10:00:00Z'));
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { title: 'Web title', notes: reminder.notes,
      remind_at: '2030-01-02T10:00:00.000Z' } });
    await restarted.sync.syncWorkspace(restarted.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.requests.filter((request) => request.path.endsWith('/push') && request.body === frozen).length, 2);
    const final = await f.cloud.db.prepare('SELECT * FROM reminders WHERE id = ?').bind(reminder.id).first();
    assert.equal(final?.remind_at, '2030-01-07T10:00:00.000Z'); assert.equal(final?.title, 'Web title');
    assert.equal(final?.notes, reminder.notes); assert.equal(final?.completed_at, null);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM interactions').first())?.n, 0);
    assert.equal((await restarted.sync.syncSummary(restarted.db)).pending, 0);
    assert.equal((await restarted.sync.syncSummary(restarted.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('overlapping snooze times require review and later phone changes retain their held status', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f);
    const reminder = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: person.id,
      title: 'Reminder', notes: 'Keep context', remind_at: '2030-01-01T10:00:00Z' } })).body.reminder;
    await run(f);
    const [shown] = await f.mobile.reminders.listOpenReminders(f.mobile.db);
    await f.mobile.reminders.snoozeReminder(f.mobile.db, shown, new Date('2030-01-02T10:00:00Z'));
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { title: reminder.title,
      notes: reminder.notes, remind_at: '2030-01-03T10:00:00Z' } });
    await run(f);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    assert.equal(review.local.remind_at, '2030-01-02T10:00:00.000Z');
    assert.equal(review.cloud?.data?.remind_at, '2030-01-03T10:00:00.000Z');
    const [held] = await f.mobile.reminders.listOpenReminders(f.mobile.db);
    await f.mobile.reminders.snoozeReminder(f.mobile.db, held, new Date('2030-01-04T10:00:00Z'));
    assert.equal(f.mobile.sqlite.prepare('SELECT sync_state FROM reminders WHERE id = ?').get(held.id).sync_state, 'conflict');
    const [fresh] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, fresh, 'phone'); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT remind_at FROM reminders WHERE id = ?').bind(reminder.id).first())?.remind_at, '2030-01-04T10:00:00.000Z');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('snooze never reopens a reminder concurrently completed on the web', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f);
    const reminder = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: person.id,
      title: 'Reminder', remind_at: '2030-01-01T10:00:00Z' } })).body.reminder;
    await run(f);
    const [shown] = await f.mobile.reminders.listOpenReminders(f.mobile.db);
    await f.mobile.reminders.snoozeReminder(f.mobile.db, shown, new Date('2030-01-02T10:00:00Z'));
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { completed: true } });
    await run(f);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 0);
    assert.ok((await f.cloud.db.prepare('SELECT completed_at FROM reminders WHERE id = ?').bind(reminder.id).first())?.completed_at);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM interactions').first())?.n, 0);
  } finally { await f.close(); }
});

test('overlapping reminder notes retain the phone draft, invalidate stale review and apply only an explicit choice', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f);
    const reminder = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Reminder', notes: 'Original', remind_at: '2030-01-01T10:00:00Z' } })).body.reminder;
    await run(f);
    await f.mobile.db.withExclusiveTransactionAsync(async (tx) => {
      await f.mobile.queue.enqueueSyncIntent(tx, 'reminder', reminder.public_id, 'update', { notes: 'Phone note' }, new Date().toISOString(), { revision: 1, values: { notes: 'Original' } });
      await tx.runAsync("UPDATE reminders SET notes = 'Phone note', sync_state = 'pending' WHERE id = ?", reminder.public_id);
    });
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { title: reminder.title, notes: 'Web note', remind_at: reminder.remind_at } });
    await run(f);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    assert.equal(review.local.notes, 'Phone note'); assert.equal(review.cloud?.data?.notes, 'Web note');
    await f.cloud.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { title: reminder.title, notes: 'Later web note', remind_at: reminder.remind_at } });
    await run(f);
    await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'phone'), /review changed/);
    const [fresh] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, fresh, 'phone'); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM reminders WHERE id = ?').bind(reminder.id).first())?.notes, 'Phone note');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('a frozen child creation retries exactly after restart and a later web deletion remains authoritative', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const history = await f.mobile.contacts.logInteraction(f.mobile.db, contact.public_id, 'call');
    let lost = false;
    const lose: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      if (String(input).endsWith('/push') && !lost) { lost = true; throw new Error('Lost reply after commit'); }
      return response;
    };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const server = await f.cloud.db.prepare('SELECT id FROM interactions WHERE public_id = ?').bind(history.id).first();
    await f.cloud.call(`interactions/${server!.id}`, { method: 'DELETE' });
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    await restarted.sync.syncContacts(restarted.db, f.account, { fetcher: f.fetcher });
    const pushes = f.requests.filter((r) => r.path.endsWith('/push') && JSON.parse(r.body!).mutation.entity === 'interaction');
    assert.equal(pushes.length, 2); assert.equal(pushes[0].body, pushes[1].body);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM interactions').first())?.count, 0);
    assert.equal((await restarted.contacts.listContactInteractions(restarted.db, contact.public_id)).length, 0);
    assert.equal((await restarted.sync.syncSummary(restarted.db)).pending, 0);
    assert.equal((await restarted.sync.syncSummary(restarted.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('version-2 cache upgrade retains a frozen version-1 contact request and safely uploads known legacy reminder completion', async () => {
  const f = await fixture(); const sqlite = new Database(':memory:');
  try {
    sqlite.exec(MOBILE_SCHEMA_SQL); sqlite.exec(MOBILE_SYNC_MIGRATION_SQL); sqlite.pragma('user_version = 2');
    const now = new Date().toISOString(), id = crypto.randomUUID(), operationId = crypto.randomUUID();
    const initial = (await f.cloud.call('v1/sync/bootstrap')).body.cursor;
    const request = JSON.stringify({ version: 1, epoch: initial.epoch, mutation: { operationId, contactId: id, type: 'create', data: { name: 'Legacy phone', notes: 'Before upload' } } });
    const committed = await f.cloud.call('v1/sync/push', { method: 'POST', body: JSON.parse(request) });
    assert.equal(committed.body.result.status, 'applied');
    sqlite.prepare('INSERT INTO contacts (id, name, notes, created_at, updated_at, sync_state) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'Legacy phone', 'Before upload', now, now, 'pending');
    sqlite.prepare("INSERT INTO app_metadata (key, value, updated_at) VALUES ('sync-cursor', ?, ?)").run(JSON.stringify(initial), now);
    sqlite.prepare("INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at, epoch, request_json) VALUES (?, 'contact', ?, 'create', ?, ?, ?, ?)").run(operationId, id, JSON.stringify({ name: 'Legacy phone', notes: 'Before upload' }), now, initial.epoch, request);
    const reminderId = crypto.randomUUID();
    sqlite.prepare('INSERT INTO reminders (id, contact_id, title, remind_at, completed_at, created_at, updated_at, sync_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(reminderId, id, 'Completed offline', '2030-01-01T10:00:00Z', now, now, now, 'pending');
    const insert = sqlite.prepare("INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at, epoch) VALUES (?, 'reminder', ?, ?, ?, ?, ?)");
    insert.run(crypto.randomUUID(), reminderId, 'create', JSON.stringify({ contactId: id, title: 'Completed offline', remindAt: '2030-01-01T10:00:00Z' }), now, initial.epoch);
    insert.run(crypto.randomUUID(), reminderId, 'update', JSON.stringify({ completedAt: now }), now, initial.epoch);
    await f.cloud.db.prepare("UPDATE contacts SET notes = 'Later web edit' WHERE public_id = ?").bind(id).run();
    const upgraded = await createMobileHarness(f.account, sqlite);
    await upgraded.sync.syncContacts(upgraded.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.requests.find((r) => r.path === 'v1/sync/push')?.body, request);
    assert.equal((await upgraded.contacts.getContact(upgraded.db, id))?.notes, 'Later web edit');
    assert.equal((await f.cloud.db.prepare('SELECT completed_at FROM reminders WHERE public_id = ?').bind(reminderId).first())?.completed_at, now);
    assert.equal((await upgraded.sync.syncSummary(upgraded.db)).pending, 0);
    assert.equal(sqlite.pragma('user_version', { simple: true }), 16);
  } finally { sqlite.close(); await f.close(); }
});

test('restore holds a frozen history mutation and explicit copying uses a new child identity', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f); await run(f);
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const history = await f.mobile.contacts.logInteraction(f.mobile.db, contact.public_id, 'call');
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = (f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'interaction'").get() as { request_json: string }).request_json;
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } });
    await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) count FROM interactions').first())?.count, 0);
    assert.equal((f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'interaction'").get() as { request_json: string }).request_json, frozen);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    assert.equal(review.reason, 'epoch_changed');
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const copy = await f.cloud.db.prepare('SELECT public_id, occurred_at FROM interactions').first();
    assert.notEqual(copy?.public_id, history.id); assert.equal(copy?.occurred_at, history.occurred_at);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('mixed bootstrap interruption and child-page write failure leave the visible replica and cursor unchanged', async () => {
  const f = await fixture();
  try {
    const contact = await webContact(f);
    await f.cloud.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: '2026-10-01', type: 'call', summary: 'Existing history' } });
    await run(f);
    for (let index = 0; index < 14; index++) await f.cloud.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: `Reminder ${index}`, remind_at: '2030-01-01T10:00:00Z' } });
    f.mobile.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run();
    let pages = 0;
    const interrupt: typeof fetch = async (input, init) => {
      if (String(input).includes('/bootstrap') && ++pages === 2) throw new Error('Download interrupted');
      return f.fetcher(input, init);
    };
    await assert.rejects(run(f, interrupt), /Offline changes are safe/);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, contact.public_id)).length, 1);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 0);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), undefined);
    await run(f);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 14);
    const before = (f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get() as { value: string }).value;
    const reminder = await f.cloud.db.prepare('SELECT id FROM reminders ORDER BY id LIMIT 1').first();
    await f.cloud.call(`reminders/${reminder!.id}`, { method: 'PATCH', body: { completed: true } });
    f.mobile.faults.sqlContains = 'INSERT INTO app_metadata';
    await assert.rejects(run(f), /Simulated local database/);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 14);
    assert.equal((f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get() as { value: string }).value, before);
    delete f.mobile.faults.sqlContains; await run(f);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db)).length, 13);
  } finally { await f.close(); }
});

test('copying a removed parent after restore preserves a frozen child draft with fresh person and child identities', async () => {
  const f = await fixture();
  try {
    const empty = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const contact = await webContact(f); await run(f);
    const history = await f.mobile.contacts.logInteraction(f.mobile.db, contact.public_id, 'call');
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = (f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'interaction'").get() as { request_json: string }).request_json;
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: empty.filename, confirmation: 'RESTORE' } });
    await run(f);
    assert.equal(f.requests.filter((request) => request.body).length, 1);
    assert.equal((f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'interaction'").get() as { request_json: string }).request_json, frozen);
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    assert.equal(review.children.length, 1);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const copiedPerson = await f.cloud.db.prepare('SELECT id, public_id FROM contacts').first();
    const copiedHistory = await f.cloud.db.prepare('SELECT public_id, contact_id, occurred_at FROM interactions').first();
    assert.notEqual(copiedPerson?.public_id, contact.public_id);
    assert.notEqual(copiedHistory?.public_id, history.id);
    assert.equal(copiedHistory?.contact_id, copiedPerson?.id); assert.equal(copiedHistory?.occurred_at, history.occurred_at);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('v4 phone bootstrap keeps all context types, reciprocal labels and bounded agenda pages', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f), leo = await webContact(f, 'Leo');
    for (let index = 0; index < 51; index++) assert.equal((await f.cloud.call('plans', { method: 'POST', body: { contact_id: ana.id, ...planDraft, summary: `Plan ${index}` } })).status, 201);
    assert.equal((await f.cloud.call(`contacts/${ana.id}/children`, { method: 'POST', body: { name: 'Leo', linked_contact_id: leo.id } })).status, 201);
    assert.equal((await f.cloud.call(`contacts/${ana.id}/relationships`, { method: 'POST', body: { related_contact_id: leo.id, relationship_label: 'Child', reciprocal_label: 'Parent' } })).status, 201);
    await run(f);
    assert.equal((await f.mobile.context.listContext(f.mobile.db, 'plan', ana.public_id)).length, 50);
    assert.equal((await f.mobile.context.listContext(f.mobile.db, 'plan', ana.public_id, 50)).length, 1);
    assert.equal((await f.mobile.context.listAgendaPlans(f.mobile.db)).length, 50);
    assert.equal((await f.mobile.context.listAgendaPlans(f.mobile.db, 50)).length, 1);
    const [family] = await f.mobile.context.listContext(f.mobile.db, 'family', ana.public_id);
    assert.equal(family.linked_contact_id, leo.public_id); assert.equal(family.linked_name, 'Leo');
    const [forward] = await f.mobile.context.listContext(f.mobile.db, 'relationship', ana.public_id);
    const [backward] = await f.mobile.context.listContext(f.mobile.db, 'relationship', leo.public_id);
    assert.equal(forward.id, backward.id); assert.equal(forward.display_label, 'Child'); assert.equal(forward.related_name, 'Leo');
    assert.equal(backward.display_label, 'Parent'); assert.equal(backward.related_name, 'Ana'); assert.equal(backward.other_contact_id, ana.public_id);
    const originalCursor = (f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get() as { value: string }).value;
    const plan = await f.cloud.db.prepare('SELECT id FROM plans LIMIT 1').first();
    await f.cloud.call(`plans/${plan!.id}`, { method: 'PATCH', body: { notes: 'New cloud note' } });
    f.mobile.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run();
    let page = 0;
    const interrupt: typeof fetch = async (input, init) => {
      if (String(input).includes('/bootstrap') && ++page === 2) throw new Error('Interrupted mixed bootstrap');
      return f.fetcher(input, init);
    };
    await assert.rejects(run(f, interrupt), /Offline changes are safe/);
    assert.equal((await f.mobile.context.listContext(f.mobile.db, 'family', ana.public_id)).length, 1);
    assert.equal((await f.mobile.context.listContext(f.mobile.db, 'relationship', leo.public_id)).length, 1);
    assert.equal((f.mobile.sqlite.prepare('SELECT count(*) n FROM plans').get() as { n: number }).n, 51);
    assert.equal((f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v2'").get() as { value: string }).value, originalCursor);
    f.mobile.faults.sqlContains = 'INSERT INTO plans';
    await assert.rejects(run(f), /Simulated local database/);
    assert.equal((f.mobile.sqlite.prepare('SELECT count(*) n FROM plans').get() as { n: number }).n, 51);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), undefined);
    delete f.mobile.faults.sqlContains; await run(f);
    assert.equal((f.mobile.sqlite.prepare("SELECT count(*) n FROM plans WHERE notes = 'New cloud note'").get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('offline contexts wait for both people and plan completion reconciles one history identity after a lost reply and restart', async () => {
  const f = await fixture();
  try {
    const ana = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Ana' }), leo = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Leo' });
    const planId = await nativePlan(f, ana.id);
    const familyId = await f.mobile.context.createContext(f.mobile.db, 'family', ana.id, { name: 'Leo', linked_contact_id: leo.id });
    const relationshipId = await f.mobile.context.createContext(f.mobile.db, 'relationship', ana.id, { related_contact_id: leo.id, relationship_label: 'Child', reciprocal_label: 'Parent' });
    const historyId = await f.mobile.context.completePlan(f.mobile.db, planId);
    assert.ok(historyId); assert.equal(await f.mobile.context.completePlan(f.mobile.db, planId), null);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.id)).length, 1);
    assert.equal((f.mobile.sqlite.prepare("SELECT count(*) n FROM sync_queue WHERE entity_type = 'interaction'").get() as { n: number }).n, 0);
    let lost = false;
    const lose: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.mutation.entity === 'plan' && body.mutation.type === 'update' && !lost) { lost = true; throw new Error('Lost completion reply'); }
      return response;
    };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const pushed = f.requests.filter((r) => r.body).map((r) => JSON.parse(r.body!));
    assert.ok(pushed.every((r) => r.version === 4));
    assert.deepEqual(pushed.slice(0, 2).map((r) => r.mutation.entity), ['contact', 'contact']);
    for (const [table, id] of [['contact_children', familyId], ['contact_relationships', relationshipId]]) assert.equal((await f.cloud.db.prepare(`SELECT count(*) n FROM ${table} WHERE public_id = ?`).bind(id).first())?.n, 1);
    const serverPlan = await f.cloud.db.prepare('SELECT id FROM plans WHERE public_id = ?').bind(planId).first();
    await f.cloud.call(`plans/${serverPlan!.id}`, { method: 'PATCH', body: { notes: 'Later web edit' } });
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    await restarted.sync.syncWorkspace(restarted.db, f.account, { fetcher: f.fetcher });
    const completions = f.requests.filter((r) => r.body && JSON.parse(r.body).mutation.entity === 'plan' && JSON.parse(r.body).mutation.type === 'update');
    assert.equal(completions.length, 2); assert.equal(completions[0].body, completions[1].body);
    const serverHistory = (await f.cloud.db.prepare('SELECT public_id FROM interactions').all()).results;
    assert.deepEqual(serverHistory.map((row) => row.public_id), [historyId]);
    const localHistory = await restarted.contacts.listContactInteractions(restarted.db, ana.id);
    assert.equal(localHistory.length, 1); assert.equal(localHistory[0].id, historyId);
    assert.equal((f.mobile.sqlite.prepare('SELECT sync_state FROM interactions WHERE id = ?').get(historyId) as { sync_state: string }).sync_state, 'synced');
    assert.equal((await restarted.context.contextForEditing(restarted.db, 'plan', planId))?.notes, 'Later web edit');
    assert.equal((await restarted.sync.syncSummary(restarted.db)).pending, 0);
  } finally { await f.close(); }
});

test('context forms retain opening bases through disjoint web edits and hold overlapping drafts for fresh review', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f), leo = await webContact(f, 'Leo'); await run(f);
    const ids = {
      plan: await nativePlan(f, ana.public_id),
      family: await f.mobile.context.createContext(f.mobile.db, 'family', ana.public_id, { name: 'Leo', linked_contact_id: leo.public_id }),
      relationship: await f.mobile.context.createContext(f.mobile.db, 'relationship', ana.public_id, { related_contact_id: leo.public_id, relationship_label: 'Child', reciprocal_label: 'Parent' }),
    };
    await run(f);
    for (const entity of ['plan', 'family', 'relationship'] as const) {
      const base = (await f.mobile.context.contextForEditing(f.mobile.db, entity, ids[entity]))!;
      const table = entity === 'plan' ? 'plans' : entity === 'family' ? 'contact_children' : 'contact_relationships';
      const changed = entity === 'plan' ? 'notes' : entity === 'family' ? 'name' : 'relationship_label';
      const disjoint = entity === 'plan' ? 'summary' : entity === 'family' ? 'birthday' : 'reciprocal_label';
      const webValue = entity === 'family' ? '2020-02-29' : 'Changed while open';
      await f.cloud.db.prepare(`UPDATE ${table} SET ${disjoint} = ? WHERE public_id = ?`).bind(webValue, ids[entity]).run();
      await run(f);
      await f.mobile.context.updateContext(f.mobile.db, entity, base, { ...base, [changed]: 'Phone edit' });
      await run(f);
      const after = (await f.mobile.context.contextForEditing(f.mobile.db, entity, ids[entity]))!;
      assert.equal(after[changed], 'Phone edit'); assert.equal(after[disjoint], webValue);
      await f.cloud.db.prepare(`UPDATE ${table} SET ${changed} = 'Overlapping web edit' WHERE public_id = ?`).bind(ids[entity]).run(); await run(f);
      await f.mobile.context.updateContext(f.mobile.db, entity, after, { ...after, [changed]: 'Second phone edit' }); await run(f);
      const [review] = (await f.mobile.sync.childSyncReviews(f.mobile.db)).filter((row) => row.entity === entity);
      assert.equal(review.local[changed], 'Second phone edit'); assert.equal(review.cloud?.data?.[changed], 'Overlapping web edit');
      await f.mobile.context.updateContext(f.mobile.db, entity, (await f.mobile.context.contextForEditing(f.mobile.db, entity, ids[entity]))!, { ...after, [changed]: 'Third phone edit' });
      assert.equal((await f.mobile.context.contextForEditing(f.mobile.db, entity, ids[entity]))?.sync_state, 'conflict', 'editing a held draft keeps its truthful review status while offline');
      await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'phone'), /review changed/);
      const [fresh] = (await f.mobile.sync.childSyncReviews(f.mobile.db)).filter((row) => row.entity === entity);
      await f.mobile.sync.resolveChildSyncReview(f.mobile.db, fresh, 'phone'); await run(f);
      assert.equal((await f.cloud.db.prepare(`SELECT ${changed} value FROM ${table} WHERE public_id = ?`).bind(ids[entity]).first())?.value, 'Third phone edit');
    }
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('a web completion wins a race and using the cloud result clears only unconfirmed phone history', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f); await run(f);
    const id = await nativePlan(f, ana.public_id); await run(f);
    const historyId = await f.mobile.context.completePlan(f.mobile.db, id);
    const server = await f.cloud.db.prepare('SELECT id FROM plans WHERE public_id = ?').bind(id).first();
    assert.equal((await f.cloud.call(`plans/${server!.id}`, { method: 'PATCH', body: { completed: true } })).status, 200);
    await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM interactions').first())?.n, 1);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    assert.equal(review.entity, 'plan'); assert.ok(review.cloud?.data?.completed_at);
    await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'phone'), /already completed/);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'cloud'); await run(f);
    const history = await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id);
    assert.equal(history.length, 1); assert.notEqual(history[0].id, historyId);
    assert.equal((f.mobile.sqlite.prepare('SELECT sync_state FROM interactions WHERE id = ?').get(history[0].id) as { sync_state: string }).sync_state, 'synced');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('restoring an open plan holds the frozen completion and explicit phone review gives its history a fresh identity', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f); await run(f);
    const id = await nativePlan(f, ana.public_id); await run(f);
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const oldHistoryId = await f.mobile.context.completePlan(f.mobile.db, id);
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const frozen = (f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'plan'").get() as { request_json: string }).request_json;
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } });
    await run(f);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db); assert.equal(review.reason, 'epoch_changed');
    assert.equal((f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'plan'").get() as { request_json: string }).request_json, frozen);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'phone');
    const staged = await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id);
    assert.equal(staged.length, 1); assert.notEqual(staged[0].id, oldHistoryId);
    await run(f);
    const history = (await f.cloud.db.prepare('SELECT public_id FROM interactions').all()).results;
    assert.deepEqual(history.map((row) => row.public_id), [staged[0].id]);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id)).length, 1);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('copying a removed person with a pending completion creates fresh person, plan and history IDs once', async () => {
  const f = await fixture();
  try {
    const empty = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const ana = await webContact(f); await run(f);
    const oldPlan = await nativePlan(f, ana.public_id); await run(f);
    const oldHistory = await f.mobile.context.completePlan(f.mobile.db, oldPlan);
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: empty.filename, confirmation: 'RESTORE' } });
    await run(f);
    const [review] = await f.mobile.sync.contactSyncReviews(f.mobile.db);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const person = await f.cloud.db.prepare('SELECT id, public_id FROM contacts').first();
    const plan = await f.cloud.db.prepare('SELECT public_id, contact_id, completed_at FROM plans').first();
    const histories = (await f.cloud.db.prepare('SELECT public_id, contact_id FROM interactions').all()).results;
    assert.notEqual(person?.public_id, ana.public_id); assert.notEqual(plan?.public_id, oldPlan); assert.ok(plan?.completed_at);
    assert.equal(plan?.contact_id, person?.id); assert.equal(histories.length, 1); assert.notEqual(histories[0].public_id, oldHistory); assert.equal(histories[0].contact_id, person?.id);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, String(person?.public_id))).length, 1);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('copying a historical completed-plan edit retains completion metadata without logging another activity', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f); await run(f);
    const beforePlan = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const id = await nativePlan(f, ana.public_id); await run(f);
    await f.mobile.context.completePlan(f.mobile.db, id); await run(f);
    const base = (await f.mobile.context.contextForEditing(f.mobile.db, 'plan', id))!;
    await f.mobile.context.updateContext(f.mobile.db, 'plan', base, { ...base, notes: 'Historical draft edit' });
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: beforePlan.filename, confirmation: 'RESTORE' } }); await run(f);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const copied = await f.cloud.db.prepare('SELECT public_id, completed_at, notes FROM plans').first();
    assert.notEqual(copied?.public_id, id); assert.equal(copied?.completed_at, base.completed_at); assert.equal(copied?.notes, 'Historical draft edit');
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM interactions').first())?.n, 0);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id)).length, 0);
  } finally { await f.close(); }
});

test('a relationship with both people removed requires separate copies and never retargets the frozen original', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f), leo = await webContact(f, 'Leo'); await run(f);
    const id = await f.mobile.context.createContext(f.mobile.db, 'relationship', ana.public_id, { related_contact_id: leo.public_id, relationship_label: 'Child', reciprocal_label: 'Parent' }); await run(f);
    const base = (await f.mobile.context.contextForEditing(f.mobile.db, 'relationship', id))!;
    await f.mobile.context.updateContext(f.mobile.db, 'relationship', base, { ...base, relationship_label: 'Loved child' });
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(run(f, lose), /Offline changes are safe/);
    const original = (f.mobile.sqlite.prepare("SELECT request_json FROM sync_queue WHERE entity_type = 'relationship'").get() as { request_json: string }).request_json;
    const nextBase = (await f.mobile.context.contextForEditing(f.mobile.db, 'relationship', id))!;
    await f.mobile.context.updateContext(f.mobile.db, 'relationship', nextBase, { ...nextBase, relationship_label: 'Loved child updated' });
    await f.cloud.call(`contacts/${ana.id}`, { method: 'DELETE' }); await f.cloud.call(`contacts/${leo.id}`, { method: 'DELETE' }); await run(f);
    const [child] = await f.mobile.sync.childSyncReviews(f.mobile.db);
    await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, child, 'copy'), /connected person was removed/);
    const originalAttempts = f.requests.filter((row) => row.body === original);
    assert.equal(originalAttempts.length, 2, 'the committed original is resolved by its exact receipt after removal');
    const first = (await f.mobile.sync.contactSyncReviews(f.mobile.db)).find((row) => row.contactId === ana.public_id)!;
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, first, 'copy'); await run(f);
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM contact_relationships').first())?.n, 0);
    const second = (await f.mobile.sync.contactSyncReviews(f.mobile.db)).find((row) => row.contactId === leo.public_id)!;
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, second, 'copy'); await run(f);
    const copied = await f.cloud.db.prepare('SELECT public_id, contact_id, related_contact_id, relationship_label FROM contact_relationships').first();
    assert.notEqual(copied?.public_id, id); assert.equal(copied?.relationship_label, 'Loved child updated');
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM contacts').first())?.n, 2);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('copying a removed linked profile explicitly relinks an existing family draft without duplicating its identity', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f), leo = await webContact(f, 'Leo'); await run(f);
    const id = await f.mobile.context.createContext(f.mobile.db, 'family', ana.public_id, { name: 'Leo', linked_contact_id: leo.public_id }); await run(f);
    const base = (await f.mobile.context.contextForEditing(f.mobile.db, 'family', id))!;
    // Unlink then relink offline to create a reviewed link intent with its opening base.
    await f.mobile.context.updateContext(f.mobile.db, 'family', base, { ...base, linked_contact_id: null });
    const unlinked = (await f.mobile.context.contextForEditing(f.mobile.db, 'family', id))!;
    await f.mobile.context.updateContext(f.mobile.db, 'family', unlinked, { ...unlinked, linked_contact_id: leo.public_id });
    await f.cloud.call(`contacts/${leo.id}`, { method: 'DELETE' }); await run(f);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db)).find((row) => row.contactId === leo.public_id)!;
    assert.ok(review);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'copy'); await run(f);
    const family = (await f.cloud.db.prepare('SELECT public_id, linked_contact_id FROM contact_children').all()).results;
    assert.equal(family.length, 1); assert.equal(family[0].public_id, id);
    const linked = await f.cloud.db.prepare('SELECT public_id FROM contacts WHERE id = ?').bind(family[0].linked_contact_id).first();
    assert.notEqual(linked?.public_id, leo.public_id); assert.ok(linked?.public_id);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('schema-3 migration preserves ordered frozen v2 requests and retries their original body before newer v4 context', async () => {
  const f = await fixture(), sqlite = new Database(':memory:');
  try {
    sqlite.exec(MOBILE_SCHEMA_SQL); sqlite.exec(MOBILE_SYNC_MIGRATION_SQL); sqlite.exec(MOBILE_ENTITY_SYNC_MIGRATION_SQL); sqlite.pragma('user_version = 3');
    const ana = await webContact(f), epoch = (await f.cloud.call('v2/sync/bootstrap')).body.cursor.epoch;
    const now = new Date().toISOString(), id = crypto.randomUUID(), operationId = crypto.randomUUID();
    const data = { contact_id: ana.public_id, title: 'Frozen v2 reminder', remind_at: '2030-01-01T10:00:00.000Z' };
    const body = JSON.stringify({ version: 2, epoch, mutation: { operationId, entity: 'reminder', entityId: id, type: 'create', data } });
    assert.equal((await f.cloud.call('v2/sync/push', { method: 'POST', body: JSON.parse(body) })).body.result.status, 'applied');
    sqlite.prepare('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(ana.public_id, ana.name, now, now);
    sqlite.prepare("INSERT INTO reminders (id, contact_id, title, remind_at, created_at, updated_at, sync_state) VALUES (?, ?, ?, ?, ?, ?, 'pending')").run(id, ana.public_id, data.title, data.remind_at, now, now);
    sqlite.prepare("INSERT INTO sync_queue (rowid, id, entity_type, entity_id, operation, payload, created_at, epoch, request_json, attempt_count) VALUES (17, ?, 'reminder', ?, 'create', ?, ?, ?, ?, 3)").run(operationId, id, JSON.stringify(data), now, epoch, body);
    const mobile = await createMobileHarness(f.account, sqlite);
    assert.equal((sqlite.prepare('SELECT rowid FROM sync_queue').get() as { rowid: number }).rowid, 17);
    assert.equal((sqlite.prepare('SELECT attempt_count FROM sync_queue').get() as { attempt_count: number }).attempt_count, 3);
    await mobile.context.createContext(mobile.db, 'plan', ana.public_id, planDraft);
    await mobile.sync.syncWorkspace(mobile.db, f.account, { fetcher: f.fetcher });
    const requests = f.requests.filter((row) => row.body);
    assert.equal(requests[0].path, 'v2/sync/push'); assert.equal(requests[0].body, body);
    assert.equal(requests[1].path, 'v4/sync/push');
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM reminders').first())?.n, 1);
    assert.equal((await mobile.sync.syncSummary(mobile.db)).pending, 0); assert.equal(sqlite.pragma('foreign_key_check').length, 0);
  } finally { sqlite.close(); await f.close(); }
});

test('invalid dates, oversized fields, self links and duplicate relationships roll back without adding intents', async () => {
  const f = await fixture();
  try {
    const ana = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Ana' }), leo = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Leo' });
    const count = () => (f.mobile.sqlite.prepare('SELECT count(*) n FROM sync_queue').get() as { n: number }).n;
    const before = count();
    for (const patch of [{ planned_date: '2026-02-30' }, { type: 'fake' }, { summary: 'x'.repeat(501) }, { notes: 'x'.repeat(10_001) }]) await assert.rejects(f.mobile.context.createContext(f.mobile.db, 'plan', ana.id, { ...planDraft, ...patch }));
    await assert.rejects(f.mobile.context.createContext(f.mobile.db, 'family', ana.id, { name: 'Child', linked_contact_id: ana.id }), /different person/);
    await assert.rejects(f.mobile.context.createContext(f.mobile.db, 'family', ana.id, { name: 'Child', linked_contact_id: leo.id, birthday: '2020-02-29' }), /same birthday/);
    assert.equal(count(), before);
    await f.mobile.context.createContext(f.mobile.db, 'relationship', ana.id, { related_contact_id: leo.id, relationship_label: 'Friend', reciprocal_label: 'Friend' });
    await assert.rejects(f.mobile.context.createContext(f.mobile.db, 'relationship', leo.id, { related_contact_id: ana.id, relationship_label: 'Friend', reciprocal_label: 'Friend' }), /already have this connection/);
    assert.equal(count(), before + 1);
  } finally { await f.close(); }
});

test('discarding a never-uploaded completion after restore resets its derived contact date without losing another pending touch', async () => {
  const f = await fixture();
  try {
    const ana = await webContact(f); await run(f);
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const id = await nativePlan(f, ana.public_id); await f.mobile.context.completePlan(f.mobile.db, id);
    assert.ok((await f.mobile.contacts.getContact(f.mobile.db, ana.public_id))?.last_contacted);
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); await run(f);
    const [review] = await f.mobile.sync.childSyncReviews(f.mobile.db); assert.equal(review.cloud, null);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'cloud');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, ana.public_id))?.last_contacted, null);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id)).length, 0);
    const another = await nativePlan(f, ana.public_id); await f.mobile.context.completePlan(f.mobile.db, another);
    await f.mobile.contacts.logInteraction(f.mobile.db, ana.public_id, 'call');
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); await run(f);
    const planReview = (await f.mobile.sync.childSyncReviews(f.mobile.db)).find((row) => row.entity === 'plan')!;
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, planReview, 'cloud');
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, ana.public_id)).length, 1);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, ana.public_id))?.last_contacted, new Date().toISOString().slice(0, 10));
  } finally { await f.close(); }
});

test('offline edits and every child association follow a chained merge without changing their original request identities', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f), other = await webContact(f, 'Other'); await run(f);
    const base = await f.mobile.contacts.getContactForEditing(f.mobile.db, b.public_id);
    await queuePatch(f, b.public_id, { phone: '+351123456789' });
    const touch = await f.mobile.contacts.logInteraction(f.mobile.db, b.public_id, 'call');
    const reminder = await f.mobile.reminders.createReminder(f.mobile.db, { contactId: b.public_id, title: 'Follow up', remindAt: '2026-10-10T10:00:00Z' }, null);
    const plan = await nativePlan(f, b.public_id);
    const family = await f.mobile.context.createContext(f.mobile.db, 'family', b.public_id, { name: 'Other', linked_contact_id: other.public_id });
    const relation = await f.mobile.context.createContext(f.mobile.db, 'relationship', b.public_id, { related_contact_id: other.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' });
    f.mobile.sqlite.prepare('UPDATE contacts SET device_contact_id = ? WHERE id = ?').run('original-device-id', b.public_id);
    const payloads = f.mobile.sqlite.prepare('SELECT id, payload FROM sync_queue ORDER BY rowid').all();
    await webMerge(f, a.id, [b.id]);
    const final = await webContact(f, 'Ana final'); await webEdit(f, final.id, { email: 'ana@example.test' }); await webMerge(f, final.id, [a.id]);
    await run(f);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.id, final.public_id);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, a.public_id))?.id, final.public_id);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.phone, '+351123456789');
    const archived = f.mobile.sqlite.prepare('SELECT deleted_at FROM contacts WHERE id = ?').get(b.public_id) as { deleted_at: string };
    assert.ok(archived.deleted_at);
    for (const [table, id] of [['interactions', touch.id], ['reminders', reminder.id], ['plans', plan], ['contact_children', family], ['contact_relationships', relation]]) {
      assert.equal((await f.cloud.db.prepare(`SELECT contact_id FROM ${table} WHERE public_id = ?`).bind(id).first())?.contact_id, final.id);
    }
    const uploads = f.requests.filter((r) => r.body).map((r) => JSON.parse(r.body!));
    assert.equal(uploads.find((r) => r.mutation.entity === 'contact').mutation.entityId, b.public_id);
    assert.equal(uploads.find((r) => r.mutation.entity === 'interaction').mutation.data.contact_id, b.public_id);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, b.public_id))[0].id, touch.id);
    assert.equal((await f.mobile.reminders.listOpenReminders(f.mobile.db, b.public_id))[0].id, reminder.id);
    assert.equal((await f.mobile.context.listContext(f.mobile.db, 'plan', b.public_id))[0].id, plan);
    const devicePreview = await f.mobile.deviceContacts.stageDeviceContact(f.mobile.db, { device_id: 'original-device-id', name: 'Device Ana', emails: [], phones: [] });
    const deviceReview = await f.mobile.deviceContacts.deviceContactReview(f.mobile.db, devicePreview, final.public_id);
    assert.equal(deviceReview.linked!.id, final.public_id);
    const captured = await f.mobile.deviceContacts.saveDeviceContactReview(f.mobile.db, devicePreview, { contact_id: final.public_id, create_name: null, use_name: false,
      emails: [], phones: [], expected_source_revision: null, expected_person: f.mobile.deviceContacts.deviceImportContactRevision(deviceReview.target!) });
    assert.equal(captured.contact_id, final.public_id);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
    assert.equal(f.mobile.sqlite.prepare('SELECT count(*) n FROM sync_queue').get().n, 0);
    assert.equal(payloads.length, 6);
    // An editor opened under the retired ID still sends its original base for comparison.
    await f.mobile.contacts.updateContact(f.mobile.db, base!, { name: base!.name, email: base!.email, phone: base!.phone, notes: 'Late opening-form edit', contactFrequency: base!.contact_frequency });
    await run(f); assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(final.id).first())?.notes, 'Late opening-form edit');
  } finally { await f.close(); }
});

test('a merged-person overlap compares against the combined profile and an explicit phone choice uses a fresh canonical operation', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    await queuePatch(f, b.public_id, { phone: 'Phone draft' }); await webEdit(f, a.id, { phone: 'Cloud value' });
    await webMerge(f, a.id, [b.id]); await run(f);
    const first = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0];
    assert.equal(first.contactId, b.public_id); assert.equal(first.changes.phone, 'Phone draft');
    assert.equal(first.mergedInto?.id, a.public_id); assert.equal(first.mergedInto?.data?.phone, 'Cloud value');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.phone, 'Cloud value');
    const held = f.mobile.sqlite.prepare('SELECT id, request_json FROM sync_queue').get() as { id: string; request_json: string };
    await assert.rejects(f.mobile.sync.resolveContactSyncReview(f.mobile.db, first, 'copy'), /still exists/);
    await webEdit(f, a.id, { phone: 'New cloud value' }); await run(f);
    await assert.rejects(f.mobile.sync.resolveContactSyncReview(f.mobile.db, first, 'phone'), /review changed/);
    const current = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0];
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, current, 'phone');
    const chosen = f.mobile.sqlite.prepare('SELECT id, entity_id, base_payload, request_json FROM sync_queue').get() as { id: string; entity_id: string; base_payload: string; request_json: string | null };
    assert.notEqual(chosen.id, held.id); assert.equal(chosen.entity_id, a.public_id); assert.equal(chosen.request_json, null);
    assert.deepEqual(JSON.parse(chosen.base_payload), { phone: 'New cloud value' });
    await run(f); assert.equal((await f.mobile.contacts.getContact(f.mobile.db, a.public_id))?.phone, 'Phone draft');
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM contacts').first())?.n, 1);
  } finally { await f.close(); }
});

test('a lost contact and history reply retries exact frozen requests after the parent is merged', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    await queuePatch(f, b.public_id, { phone: 'Before merge' });
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost committed reply'); return response; };
    await assert.rejects(run(f, lose));
    const before = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue').get().request_json;
    await webMerge(f, a.id, [b.id]); await webEdit(f, a.id, { phone: 'Later cloud' });
    await run(f); assert.equal(f.requests.filter((r) => r.body)[1].body, before);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.phone, 'Later cloud');
    const second = await webContact(f, 'Ana again'); await webEdit(f, second.id, { email: 'ana@example.test' }); await run(f);
    const touch = await f.mobile.contacts.logInteraction(f.mobile.db, second.public_id, 'email');
    await assert.rejects(run(f, lose));
    const childBody = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue').get().request_json;
    await webMerge(f, a.id, [second.id]);
    const restarted = await createMobileHarness(f.account, f.mobile.sqlite);
    await restarted.sync.syncWorkspace(restarted.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.requests.filter((r) => r.body).at(-1)?.body, childBody);
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM interactions WHERE public_id = ?').bind(touch.id).first())?.n, 1);
    assert.equal((await f.mobile.contacts.listContactInteractions(f.mobile.db, second.public_id))[0].id, touch.id);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('a merge that collapses an offline family or relationship holds the original draft for review', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const family = await f.mobile.context.createContext(f.mobile.db, 'family', a.public_id, { name: 'Ana mobile', linked_contact_id: b.public_id });
    const relationship = await f.mobile.context.createContext(f.mobile.db, 'relationship', a.public_id, { related_contact_id: b.public_id, relationship_label: 'Close friend', reciprocal_label: 'Friend' });
    const payloads = f.mobile.sqlite.prepare('SELECT id, payload FROM sync_queue ORDER BY rowid').all();
    await webMerge(f, a.id, [b.id]); await run(f);
    assert.equal(f.requests.filter((r) => r.body).length, 0);
    assert.deepEqual(f.mobile.sqlite.prepare('SELECT id, payload FROM sync_queue ORDER BY rowid').all(), payloads);
    const reviews = await f.mobile.sync.childSyncReviews(f.mobile.db); assert.equal(reviews.length, 2);
    for (const review of reviews) {
      assert.equal(review.reason, 'merged_self_link');
      await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'copy'), /merged into one/);
      await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'cloud');
    }
    assert.equal(f.mobile.sqlite.prepare('SELECT deleted_at FROM contact_children WHERE id = ?').get(family).deleted_at !== null, true);
    assert.equal(f.mobile.sqlite.prepare('SELECT deleted_at FROM contact_relationships WHERE id = ?').get(relationship).deleted_at !== null, true);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
  } finally { await f.close(); }
});

test('an old pending deletion never removes a surviving merged person', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const base = await f.mobile.contacts.getContactForEditing(f.mobile.db, b.public_id);
    await f.mobile.queue.enqueueSyncIntent(f.mobile.db, 'contact', b.public_id, 'delete', {}, new Date().toISOString(), { revision: base!.remote_revision, values: {} });
    await webMerge(f, a.id, [b.id]); await run(f);
    assert.equal(f.requests.filter((r) => r.body).length, 0);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0]; assert.equal(review.reason, 'merged_contact_delete');
    await assert.rejects(f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'phone'), /no supported contact edit/);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'cloud');
    assert.ok(await f.mobile.contacts.getContact(f.mobile.db, b.public_id));
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM contacts').first())?.n, 1);
  } finally { await f.close(); }
});

test('alias publication and cursor roll back together and restore rebuilds only the new dataset aliases', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const snapshot = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    const previous = f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get().value;
    await queuePatch(f, b.public_id, { phone: 'Held across restore' });
    await webMerge(f, a.id, [b.id]);
    f.mobile.faults.sqlContains = 'INSERT INTO contact_aliases';
    await assert.rejects(run(f), /Simulated local database/);
    assert.equal(f.mobile.sqlite.prepare('SELECT count(*) n FROM contact_aliases').get().n, 0);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get().value, previous);
    delete f.mobile.faults.sqlContains;
    // Force a complete staged download to exercise aliases before removed contacts.
    f.mobile.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run();
    await run(f); assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.id, a.public_id);
    await queuePatch(f, a.public_id, { notes: 'Old epoch draft' });
    const restored = await f.cloud.call('settings/restore', { method: 'POST', body: { filename: snapshot.filename, confirmation: 'RESTORE' } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body)); await f.reauthorize(); await run(f);
    assert.equal(f.mobile.sqlite.prepare('SELECT count(*) n FROM contact_aliases').get().n, 0);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, b.public_id))?.id, b.public_id);
    assert.equal((await f.mobile.sync.contactSyncReviews(f.mobile.db))[0].reason, 'epoch_changed');
    assert.equal((await f.cloud.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(a.id).first())?.notes, 'From web');
  } finally { await f.close(); }
});

test('schema-4 cache upgrade retains frozen operations and local-only identities when adding aliases', async () => {
  const f = await fixture();
  try {
    const { b } = await duplicatePeople(f); await queuePatch(f, b.public_id, { phone: 'Uncertain edit' });
    const fail: typeof fetch = async (input, init) => { if (String(input).endsWith('/push')) throw new Error('Offline'); return f.fetcher(input, init); };
    await assert.rejects(run(f, fail));
    const before = f.mobile.sqlite.prepare('SELECT * FROM sync_queue ORDER BY rowid').all();
    f.mobile.sqlite.exec('DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; DROP TABLE device_source_queue; ALTER TABLE contacts DROP COLUMN device_links; DROP TABLE device_contact_links; DROP TABLE device_contact_previews; DROP TABLE contact_aliases; ALTER TABLE contacts DROP COLUMN contact_methods; ALTER TABLE contacts DROP COLUMN source_links; ALTER TABLE contacts DROP COLUMN provider_links; PRAGMA user_version = 4;');
    const upgraded = await createMobileHarness(f.account, f.mobile.sqlite);
    assert.equal(f.mobile.sqlite.pragma('user_version', { simple: true }), 16);
    assert.deepEqual(f.mobile.sqlite.prepare('SELECT * FROM sync_queue ORDER BY rowid').all(), before);
    await upgraded.sync.syncWorkspace(upgraded.db, f.account, { fetcher: f.fetcher });
    assert.equal((await upgraded.contacts.getContact(upgraded.db, b.public_id))?.phone, 'Uncertain edit');
  } finally { await f.close(); }
});

test('a cloud connection removed by merge retains its edited self-link draft and using cloud discards only that item', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const id = await f.mobile.context.createContext(f.mobile.db, 'relationship', a.public_id, { related_contact_id: b.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' });
    await run(f);
    const base = await f.mobile.context.contextForEditing(f.mobile.db, 'relationship', id);
    await f.mobile.context.updateContext(f.mobile.db, 'relationship', base!, { related_contact_id: b.public_id, relationship_label: 'Close friend', reciprocal_label: 'Friend' });
    await webMerge(f, a.id, [b.id]); await run(f);
    const review = (await f.mobile.sync.childSyncReviews(f.mobile.db))[0];
    assert.equal(review.reason, 'merged_self_link'); assert.equal(review.local.relationship_label, 'Close friend');
    assert.equal(review.cloud?.deleted, true);
    await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'phone'), /merged into one/);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'cloud');
    assert.equal((await f.mobile.sync.childSyncReviews(f.mobile.db)).length, 0);
    assert.ok(await f.mobile.contacts.getContact(f.mobile.db, a.public_id));
  } finally { await f.close(); }
});

test('an uncertain frozen self-link retries its original body and becomes reviewable only after server rejection', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const id = await f.mobile.context.createContext(f.mobile.db, 'relationship', a.public_id, { related_contact_id: b.public_id, relationship_label: 'Friend', reciprocal_label: 'Friend' });
    const offline: typeof fetch = async (input, init) => { if (String(input).endsWith('/push')) throw new Error('Offline before acknowledgement'); return f.fetcher(input, init); };
    await assert.rejects(run(f, offline));
    const before = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue').get().request_json;
    await webMerge(f, a.id, [b.id]); await run(f);
    assert.equal(f.requests.filter((r) => r.body).at(-1)?.body, before);
    const held = f.mobile.sqlite.prepare('SELECT request_json, last_error_code FROM sync_queue').get();
    assert.equal(held.request_json, before); assert.equal(held.last_error_code, 'merged_self_link');
    const review = (await f.mobile.sync.childSyncReviews(f.mobile.db))[0]; assert.equal(review.entityId, id);
    assert.equal(review.local.relationship_label, 'Friend');
    await assert.rejects(f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'copy'), /merged into one/);
    await f.mobile.sync.resolveChildSyncReview(f.mobile.db, review, 'cloud');
    assert.equal((await f.cloud.db.prepare('SELECT count(*) n FROM contact_relationships').first())?.n, 0);
  } finally { await f.close(); }
});

test('multiple phone methods captured and edited before first sync keep their UUIDs and preferred values on web', async () => {
  const f = await fixture();
  try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Ana methods', email: 'ana@example.test' });
    const original = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.id);
    const methods = JSON.parse(original!.contact_methods), work = { id: crypto.randomUUID(), kind: 'email', value: 'work@example.test', label: 'Work', country: null, preferred: true };
    const profile = { id: crypto.randomUUID(), kind: 'profile', value: 'https://www.linkedin.com/in/ana', label: 'LinkedIn', country: null, preferred: false };
    await f.mobile.methods.updateContactMethods(f.mobile.db, original!, [...methods.map((item: Record<string, unknown>) => ({ ...item, preferred: false })), work, profile]);
    await run(f);
    const server = (await f.cloud.db.prepare('SELECT * FROM contacts WHERE public_id = ?').bind(person.id).first())!;
    assert.equal(server.email, work.value);
    const uploaded = JSON.parse(String(server.contact_methods));
    assert.deepEqual(uploaded.map((item: { id: string }) => item.id).sort(), [...methods.map((item: { id: string }) => item.id), work.id, profile.id].sort());
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 0);
    assert.equal((await f.mobile.contacts.listContacts(f.mobile.db, work.value))[0].id, person.id);
    const web = await f.cloud.call(`contacts/${server.id}`);
    const changed = uploaded.map((item: { id: string; value: string }) => item.id === profile.id ? { ...item, value: 'https://www.linkedin.com/in/ana-new' } : item);
    assert.equal((await f.cloud.call(`contacts/${server.id}`, { method: 'PATCH', body: { expected_edit_revision: web.body.contact.edit_revision, contact_methods: changed } })).status, 200);
    await run(f); assert.equal(JSON.parse((await f.mobile.contacts.getContact(f.mobile.db, person.id))!.contact_methods).find((item: { id: string }) => item.id === profile.id).value, 'https://www.linkedin.com/in/ana-new');
  } finally { await f.close(); }
});

test('method forms keep their opening base, merge disjoint web fields and preserve newly added cloud methods during explicit review', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f); await webEdit(f, person.id, { email: 'ana@example.test' }); await run(f);
    const original = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.public_id), base = JSON.parse(original!.contact_methods);
    await webEdit(f, person.id, { name: 'Ana renamed' });
    const first = base.map((item: Record<string, unknown>) => ({ ...item, label: 'Personal' }));
    await f.mobile.methods.updateContactMethods(f.mobile.db, original!, first); await run(f);
    assert.equal((await f.mobile.sync.contactSyncReviews(f.mobile.db)).length, 0);
    const second = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.public_id), phone = JSON.parse(second!.contact_methods).map((item: Record<string, unknown>) => ({ ...item, value: 'phone-choice@example.test' }));
    const remote = (await f.cloud.call(`contacts/${person.id}`)).body.contact;
    const extra = { id: crypto.randomUUID(), kind: 'email', value: 'new-cloud@example.test', label: 'New work', country: null, preferred: false };
    await f.cloud.call(`contacts/${person.id}`, { method: 'PATCH', body: { contact_methods: [...JSON.parse(remote.contact_methods), extra], expected_edit_revision: remote.edit_revision } });
    await f.mobile.methods.updateContactMethods(f.mobile.db, second!, phone); await run(f);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0]; assert.equal(review.contactId, person.public_id);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'phone'); await run(f);
    const chosen = JSON.parse((await f.mobile.contacts.getContact(f.mobile.db, person.public_id))!.contact_methods);
    assert.equal(chosen.find((item: { id: string }) => item.id === extra.id).value, extra.value);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, person.public_id))!.email, 'phone-choice@example.test');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, person.public_id))!.name, 'Ana renamed');
  } finally { await f.close(); }
});

test('method review after a person merge retains the survivor methods and applies only the old draft fields', async () => {
  const f = await fixture();
  try {
    const { a, b } = await duplicatePeople(f);
    const original = await f.mobile.contacts.getContactForEditing(f.mobile.db, b.public_id), methods = JSON.parse(original!.contact_methods);
    await f.mobile.methods.updateContactMethods(f.mobile.db, original!, methods.map((item: Record<string, unknown>) => ({ ...item, value: 'other-source@example.test' })));
    const currentA = await f.mobile.contacts.getContactForEditing(f.mobile.db, a.public_id), originalA = JSON.parse(currentA!.contact_methods)[0];
    await webMerge(f, a.id, [b.id]); await run(f);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0]; assert.equal(review.mergedInto?.id, a.public_id);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'phone'); await run(f);
    const combined = JSON.parse((await f.mobile.contacts.getContact(f.mobile.db, a.public_id))!.contact_methods);
    assert.equal(combined.length, 2); assert.equal(combined.find((item: { id: string }) => item.id === originalA.id).value, originalA.value);
    assert.equal(combined.find((item: { id: string }) => item.id === methods[0].id).value, 'other-source@example.test');
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, a.public_id))!.email, originalA.value);
  } finally { await f.close(); }
});

test('lost method acknowledgements retry exactly and cannot replace a newer cloud method value', async () => {
  const f = await fixture();
  try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Methods', email: 'ana@example.test' }); await run(f);
    const base = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.id), draft = JSON.parse(base!.contact_methods).map((item: Record<string, unknown>) => ({ ...item, label: 'Phone label' }));
    await f.mobile.methods.updateContactMethods(f.mobile.db, base!, draft);
    const lose: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).endsWith('/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(run(f, lose));
    const body = f.mobile.sqlite.prepare('SELECT request_json FROM sync_queue').get().request_json;
    const server = (await f.cloud.db.prepare('SELECT id FROM contacts WHERE public_id = ?').bind(person.id).first())!;
    const remote = (await f.cloud.call(`contacts/${server.id}`)).body.contact;
    await f.cloud.call(`contacts/${server.id}`, { method: 'PATCH', body: { contact_methods: JSON.parse(remote.contact_methods).map((item: Record<string, unknown>) => ({ ...item, label: 'Later web label' })), expected_edit_revision: remote.edit_revision } });
    await run(f); assert.equal(f.requests.filter((r) => r.body).at(-1)?.body, body);
    assert.equal(JSON.parse((await f.mobile.contacts.getContact(f.mobile.db, person.id))!.contact_methods)[0].label, 'Later web label');
  } finally { await f.close(); }
});

test('schema-5 upgrade refreshes cloud method identities and explicit review reconciles an offline provisional method without duplicating it', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f); await webEdit(f, person.id, { email: 'original@example.test' }); await run(f);
    const serverMethod = JSON.parse((await f.cloud.call(`contacts/${person.id}`)).body.contact.contact_methods)[0];
    f.mobile.sqlite.exec('DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; DROP TABLE device_source_queue; ALTER TABLE contacts DROP COLUMN device_links; DROP TABLE device_contact_links; DROP TABLE device_contact_previews; ALTER TABLE contacts DROP COLUMN contact_methods; ALTER TABLE contacts DROP COLUMN source_links; ALTER TABLE contacts DROP COLUMN provider_links; PRAGMA user_version = 5;');
    await f.mobile.database.migrateDatabase(f.mobile.db);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), undefined);
    const opening = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.public_id);
    const provisional = JSON.parse(opening!.contact_methods);
    assert.notEqual(provisional[0].id, serverMethod.id);
    await f.mobile.methods.updateContactMethods(f.mobile.db, opening!, provisional.map((item: Record<string, unknown>) => ({ ...item, value: 'after-upgrade@example.test' })));
    await run(f);
    const review = (await f.mobile.sync.contactSyncReviews(f.mobile.db))[0];
    assert.ok(review);
    await f.mobile.sync.resolveContactSyncReview(f.mobile.db, review, 'phone'); await run(f);
    const result = JSON.parse((await f.cloud.call(`contacts/${person.id}`)).body.contact.contact_methods);
    assert.equal(result.length, 1); assert.equal(result[0].id, serverMethod.id); assert.equal(result[0].value, 'after-upgrade@example.test');
  } finally { await f.close(); }
});

test('an exact older receipt without methods preserves the current method IDs and secondary data in the phone cache', async () => {
  const f = await fixture();
  try {
    const person = await webContact(f); await webEdit(f, person.id, { email: 'original@example.test' }); await run(f);
    const opening = await f.mobile.contacts.getContactForEditing(f.mobile.db, person.public_id);
    const extra = { id: crypto.randomUUID(), kind: 'email', value: 'secondary@example.test', label: 'Work', country: null, preferred: false };
    await f.mobile.methods.updateContactMethods(f.mobile.db, opening!, [...JSON.parse(opening!.contact_methods), extra]); await run(f);
    const current = (await f.mobile.contacts.getContactForEditing(f.mobile.db, person.public_id))!;
    await f.mobile.contacts.updateContact(f.mobile.db, current, { ...current, name: 'Older receipt name' });
    await run(f, async (input, init) => {
      const response = await f.fetcher(input, init);
      if (!String(input).endsWith('/v4/sync/push')) return response;
      const body = await response.json();
      if (body.result?.record?.entity === 'contact' && body.result.record.data) delete body.result.record.data.contact_methods;
      return Response.json(body, { status: response.status });
    });
    const final = (await f.mobile.contacts.getContact(f.mobile.db, person.public_id))!;
    assert.equal(final.name, 'Older receipt name');
    assert.equal(final.contact_methods, current.contact_methods, 'Preserve the exact collection used by future compare-and-swap edits.');
    assert.deepEqual(JSON.parse(final.contact_methods).map((item: { id: string }) => item.id).sort(), JSON.parse(current.contact_methods).map((item: { id: string }) => item.id).sort());
    assert.equal(JSON.parse(final.contact_methods).find((item: { id: string }) => item.id === extra.id).label, 'Work');
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).pending, 0);
  } finally { await f.close(); }
});
