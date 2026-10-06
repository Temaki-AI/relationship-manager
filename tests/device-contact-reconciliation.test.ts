import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { DEVICE_TOKEN_PREFIX, readNativeAccount } from '../packages/domain/src/devices.ts';
import { readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { readDeviceContactFacts, type DeviceContactFacts } from '../packages/domain/src/device-contact-facts.ts';
import { observeDeviceMethod, readDeviceRules, reconcileDeviceFields } from '../packages/domain/src/device-contact-rules.ts';
import { ProviderSourceError } from '../packages/domain/src/provider-sources.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';

const account = readNativeAccount({ deviceId: crypto.randomUUID(), userId: 'owner', workspaceId: 'test', email: 'owner@example.test', name: 'Owner',
  expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://everclosecrm.com', token: DEVICE_TOKEN_PREFIX + Buffer.alloc(32, 19).toString('base64url') });
type Mobile = Awaited<ReturnType<typeof createMobileHarness>>;
type Choice = Parameters<Mobile['deviceReconciliation']['changeDevicePolicy']>[2];
function facts(patch: Partial<DeviceContactFacts> = {}): DeviceContactFacts {
  return { device_id: 'iphone-person', name: 'Ana', emails: [{ source_id: 'email-work', value: 'ana@example.test', label: 'Work' }],
    phones: [{ source_id: 'phone-mobile', value: '+351912345678', label: 'Mobile' }], ...patch };
}
async function fixture(shared = false) {
  const m = await createMobileHarness(account), epoch = crypto.randomUUID();
  m.sqlite.prepare("INSERT INTO app_metadata (key, value, updated_at) VALUES ('sync-cursor-v3', ?, ?)").run(JSON.stringify({ epoch, sequence: 12 }), new Date().toISOString());
  const preview = await m.deviceContacts.stageDeviceContact(m.db, facts());
  const saved = await m.deviceContacts.saveDeviceContactReview(m.db, preview, { contact_id: null, create_name: 'Ana', use_name: true,
    emails: [0], phones: [0], expected_person: null, expected_source_revision: null, publish_source: shared });
  const source = (await m.deviceContacts.listDeviceContactLinks(m.db, saved.contact_id))[0];
  // Model acknowledged setup operations. Individual tests assert the new durable intents.
  m.sqlite.exec('DELETE FROM sync_queue; DELETE FROM device_source_queue;');
  m.sqlite.prepare("UPDATE contacts SET sync_state = 'synced', notes = 'Private relationship note' WHERE id = ?").run(saved.contact_id);
  m.sqlite.prepare('INSERT INTO sync_remote_contacts (id, record_json) VALUES (?, ?)').run(saved.contact_id, JSON.stringify({ revision: 1 }));
  if (shared) m.sqlite.prepare('UPDATE device_contact_links SET cloud_revision = 1 WHERE id = ?').run(source.id);
  return { m, source, epoch, personId: saved.contact_id };
}
async function configure(m: Mobile, sourceId: string, patch: Partial<Choice> = {}) {
  const review = await m.deviceReconciliation.devicePolicyReview(m.db, sourceId);
  return { expected_policy_revision: review.policy.revision, expected_source_revision: review.source.revision, expected_person: review.personRevision,
    enabled: true, name: 'follow', methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: 'follow' })), reset: [], ...patch } as Choice;
}
async function read(m: Mobile, sourceId: string, observation: DeviceContactFacts) {
  const [intent] = await m.deviceReconciliation.nextDeviceReads(m.db, sourceId); assert.ok(intent);
  return m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'available', facts: observation });
}
function pending(m: Mobile, table = 'sync_queue') { return m.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }

test('reading starts disabled, keeps fields by default and never infers consent from a saved source', async () => {
  const { m, source, personId } = await fixture();
  try {
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db), []);
    const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(review.policy.enabled, 0); assert.equal(review.fields.name.mode, 'keep'); assert.ok(review.fields.methods.every((rule) => rule.mode === 'keep'));
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { name: 'keep', methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: 'keep' })) }));
    await read(m, source.id, facts({ name: 'Source changed', emails: [{ source_id: 'email-work', value: 'new@example.test', label: 'Work' }] }));
    const person = (await m.contacts.getContact(m.db, personId))!;
    assert.equal(person.name, 'Ana'); assert.equal(person.email, 'ana@example.test'); assert.equal(person.notes, 'Private relationship note');
    const updated = (await m.deviceReconciliation.devicePolicyReview(m.db, source.id)).source;
    assert.equal(updated.original_facts, source.original_facts); assert.equal(JSON.parse(updated.observed_facts).name, 'Source changed');
    assert.equal(pending(m).length, 0); assert.equal(pending(m, 'device_source_queue').length, 0);
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db), []); // hourly foreground cadence
  } finally { m.close(); }
});

test('approved recurring fields retain method identity, preference, private history and atomically queue changed shared facts', async () => {
  const { m, source, personId } = await fixture(true);
  try {
    const before = (await m.contacts.getContact(m.db, personId))!, methods = readContactMethods(before.contact_methods);
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    await read(m, source.id, facts({ name: 'Ana Updated', emails: [{ source_id: 'email-work', value: 'new@example.test', label: 'Renamed OS label' }],
      phones: [{ source_id: 'phone-mobile', value: '+351919876543', label: 'Another label' }] }));
    const person = (await m.contacts.getContact(m.db, personId))!, changed = readContactMethods(person.contact_methods);
    assert.equal(person.name, 'Ana Updated'); assert.equal(person.email, 'new@example.test'); assert.equal(person.phone, '+351919876543'); assert.equal(person.notes, before.notes);
    for (let index = 0; index < methods.length; index++) assert.deepEqual({ ...changed[index], value: methods[index].value }, methods[index]);
    assert.equal(pending(m).length, 1); assert.equal(pending(m, 'device_source_queue').length, 1);
    const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(review.fields.name.overridden, false); assert.ok(review.fields.methods.every((rule) => !rule.overridden));
    assert.equal(review.source.original_facts, source.original_facts);
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db, source.id), []); // wait for durable intents to settle
  } finally { m.close(); }
});

test('a CRM correction remains sticky even if reverted; stopping reads requires no reset and explicit reset resumes only selected fields', async () => {
  const { m, source, personId } = await fixture();
  try {
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    const original = readContactMethods((await m.contacts.getContact(m.db, personId))!.contact_methods), corrected = original.map((method) => ({ ...method, value: method.kind === 'email' ? 'my-correction@example.test' : method.value }));
    m.sqlite.prepare('UPDATE contacts SET name = ?, contact_methods = ? WHERE id = ?').run('My Ana', JSON.stringify(corrected), personId);
    m.sqlite.prepare('UPDATE contacts SET name = ?, contact_methods = ? WHERE id = ?').run('Ana', JSON.stringify(original), personId);
    let review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(review.fields.name.overridden, true); assert.equal(review.fields.methods.find((rule) => rule.kind === 'email')!.overridden, true);
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { enabled: false }));
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db, source.id), []);
    await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id)), /Confirm Use iPhone value/);
    // Consent may resume with fields held; source facts still update without replacing corrections.
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { name: 'keep', methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: 'keep' })) }));
    await read(m, source.id, facts({ name: 'New source name', emails: [{ source_id: 'email-work', value: 'source@example.test', label: 'Work' }] }));
    assert.equal((await m.contacts.getContact(m.db, personId))!.name, 'Ana');
    review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id); const email = review.fields.methods.find((rule) => rule.kind === 'email')!;
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { name: 'keep',
      methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: rule.id === email.id ? 'follow' : 'keep' })), reset: [email.id] }));
    const resumed = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(resumed.person.email, 'source@example.test'); assert.equal(resumed.person.name, 'Ana');
    assert.equal(resumed.fields.name.overridden, true); assert.equal(resumed.fields.methods.find((rule) => rule.id === email.id)!.overridden, false);
    assert.equal(pending(m).length, 1);
  } finally { m.close(); }
});

test('stable OS field identifiers never fall back to another equal value, and ambiguous fields require an explicit binding', async () => {
  const { m, source } = await fixture();
  try {
    const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id), rule = review.fields.methods.find((item) => item.kind === 'email')!;
    assert.deepEqual(observeDeviceMethod(rule, facts({ emails: [{ source_id: 'different', value: 'ana@example.test', label: 'Work' }] })), { index: null, issue: 'missing' });
    assert.deepEqual(observeDeviceMethod(rule, facts({ emails: [facts().emails[0], facts().emails[0]] })), { index: null, issue: 'ambiguous' });
    const anonymous = { ...rule, slot: { ...rule.slot!, source_id: null } };
    assert.deepEqual(observeDeviceMethod(anonymous, facts({ emails: [{ source_id: null, value: 'changed@example.test', label: 'Work' }] })), { index: 0, issue: null });
    assert.equal(observeDeviceMethod(anonymous, facts({ emails: [{ source_id: null, value: 'changed@example.test', label: 'Work' }, { source_id: null, value: 'also@example.test', label: 'Work' }] })).issue, 'ambiguous');
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    await read(m, source.id, facts({ emails: [{ source_id: 'replacement', value: 'replacement@example.test', label: 'Work' }] }));
    let updated = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(updated.person.email, 'ana@example.test'); assert.equal(updated.fields.methods.find((item) => item.id === rule.id)!.issue, 'missing');
    await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { methods: updated.fields.methods.map((item) => ({ id: item.id, mode: 'follow', ...(item.id === rule.id ? { slot_index: 0 } : {}) })) })), /Confirm Use iPhone value/);
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { reset: [rule.id], methods: updated.fields.methods.map((item) => ({ id: item.id, mode: 'follow', ...(item.id === rule.id ? { slot_index: 0 } : {}) })) }));
    updated = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(updated.person.email, 'replacement@example.test'); assert.equal(updated.fields.methods.find((item) => item.id === rule.id)!.slot!.source_id, 'replacement');
  } finally { m.close(); }
});

test('missing and invalid source values preserve the relationship and preferred contact methods', async () => {
  const { m, source, personId } = await fixture();
  try {
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    await read(m, source.id, facts({ name: null, emails: [], phones: [{ source_id: 'phone-mobile', value: 'not a telephone', label: 'Mobile' }] }));
    const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(review.person.id, personId); assert.equal(review.person.name, 'Ana'); assert.equal(review.person.email, 'ana@example.test'); assert.equal(review.person.phone, '+351912345678');
    assert.equal(review.fields.name.issue, 'missing'); assert.equal(review.fields.methods.find((rule) => rule.kind === 'email')!.issue, 'missing');
    assert.equal(review.fields.methods.find((rule) => rule.kind === 'phone')!.issue, 'invalid'); assert.equal(pending(m).length, 0);
    assert.equal(reconcileDeviceFields(review.fields, review.person.name, review.person.contact_methods, null).name, 'Ana');
  } finally { m.close(); }
});

test('access loss and uncertain store errors update local status without deleting or publishing source removals', async () => {
  const { m, source, personId } = await fixture(true);
  try {
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    for (const state of ['access_lost', 'unavailable', 'error'] as const) {
      const [intent] = await m.deviceReconciliation.nextDeviceReads(m.db, source.id); assert.ok(intent);
      assert.equal(await m.deviceReconciliation.commitDeviceRead(m.db, intent, { state }), true);
      const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
      assert.equal(review.policy.state, state); assert.equal(review.source.observed_facts, source.observed_facts); assert.equal(review.person.id, personId);
      assert.equal(review.person.name, 'Ana'); assert.equal(review.policy.last_success_at, null);
    }
    assert.equal(pending(m).length, 0); assert.equal(pending(m, 'device_source_queue').length, 0);
  } finally { m.close(); }
});

for (const fence of ['disabled', 'edited', 'unlinked', 'merged', 'restored', 'account', 'installation', 'generation', 'queued'] as const) {
  test(`a delayed iPhone read is fenced after ${fence}`, async () => {
    const { m, source, personId } = await fixture();
    try {
      await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
      const [intent] = await m.deviceReconciliation.nextDeviceReads(m.db, source.id); assert.ok(intent);
      if (fence === 'disabled') await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id, { enabled: false }));
      if (fence === 'edited') m.sqlite.prepare('UPDATE contacts SET name = ? WHERE id = ?').run('Corrected Ana', personId);
      if (fence === 'unlinked') await m.deviceContacts.unlinkDeviceContact(m.db, source);
      if (fence === 'merged') {
        const other = await m.contacts.createContact(m.db, { name: 'Canonical person' });
        m.sqlite.prepare('UPDATE device_contact_links SET contact_id = ? WHERE id = ?').run(other.id, source.id);
        const policy = m.sqlite.prepare('SELECT * FROM device_contact_policies WHERE source_id = ?').get(source.id);
        assert.equal(policy.enabled, 0); assert.equal(policy.reason, 'merged');
      }
      if (fence === 'restored') m.sqlite.prepare("UPDATE app_metadata SET value = ? WHERE key = 'sync-cursor-v3'").run(JSON.stringify({ epoch: crypto.randomUUID(), sequence: 0 }));
      if (fence === 'account') m.sqlite.prepare("UPDATE app_metadata SET value = 'other-account' WHERE key = 'account-scope'").run();
      if (fence === 'installation') await m.deviceSourceSync.bindDeviceInstallation(m.db, crypto.randomUUID());
      if (fence === 'queued') await m.queue.enqueueSyncIntent(m.db, 'contact', personId, 'update', { notes: 'queued' }, new Date().toISOString(), { revision: 1, values: { notes: 'Private relationship note' } });
      const before = await m.contacts.getContact(m.db, personId), queuedBefore = pending(m);
      assert.equal(await m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'available', facts: facts({ name: 'Stale read' }) }, () => fence !== 'generation'), false);
      assert.deepEqual(await m.contacts.getContact(m.db, personId), before); assert.deepEqual(pending(m), queuedBefore);
      if (fence === 'restored') {
        assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db, source.id), []);
        const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id); assert.equal(review.policy.enabled, 0); assert.equal(review.policy.reason, 'restored');
      }
    } finally { m.close(); }
  });
}

test('failed observation/source queue writes roll back accepted field changes, policy baselines and outbox intents together', async () => {
  const { m, source, personId } = await fixture(true);
  try {
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    const before = await m.deviceReconciliation.devicePolicyReview(m.db, source.id), [intent] = await m.deviceReconciliation.nextDeviceReads(m.db, source.id);
    m.faults.sqlContains = 'UPDATE device_contact_links SET observed_facts';
    await assert.rejects(m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'available', facts: facts({ name: 'Never committed' }) }), /Simulated/);
    delete m.faults.sqlContains;
    assert.equal((await m.contacts.getContact(m.db, personId))!.name, 'Ana');
    const after = await m.deviceReconciliation.devicePolicyReview(m.db, source.id); assert.deepEqual(after.policy, before.policy); assert.deepEqual(after.source, before.source);
    assert.equal(pending(m).length, 0); assert.equal(pending(m, 'device_source_queue').length, 0);
    assert.equal(await m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'available', facts: facts({ name: 'Now committed' }) }), true);
  } finally { m.close(); }
});

test('a source collection exceeding its byte limit rolls back the new observation, followed name and all intents', async () => {
  const { m, source, personId } = await fixture();
  try {
    const large = facts({ phones: [], emails: Array.from({ length: 72 }, (_, index) => ({ source_id: `${index}-` + 's'.repeat(78),
      value: `${index}.` + 'a'.repeat(70) + '@example.test', label: 'l'.repeat(70) })) });
    for (let index = 0; index < 3; index++) {
      const preview = await m.deviceContacts.stageDeviceContact(m.db, { ...large, device_id: `large-${index}` });
      const review = await m.deviceContacts.deviceContactReview(m.db, preview, personId);
      await m.deviceContacts.saveDeviceContactReview(m.db, preview, { contact_id: personId, create_name: null, use_name: false, emails: [], phones: [],
        expected_person: m.deviceContacts.deviceImportContactRevision(review.target!), expected_source_revision: null });
    }
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    const before = await m.deviceReconciliation.devicePolicyReview(m.db, source.id), [intent] = await m.deviceReconciliation.nextDeviceReads(m.db, source.id);
    await assert.rejects(m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'available', facts: { ...large, device_id: source.device_contact_id, name: 'Must roll back' } }), /source limit/);
    const after = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    assert.equal(after.person.name, 'Ana'); assert.equal(after.person.email, 'ana@example.test'); assert.equal(after.source.observed_facts, before.source.observed_facts);
    assert.deepEqual(after.policy, before.policy); assert.equal(pending(m).length, 0); assert.equal(pending(m, 'device_source_queue').length, 0);
    // The runner can now report the failed read against the unchanged intent.
    assert.equal(await m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'error', reason: 'read_or_capacity_error' }), true);
    assert.equal((await m.deviceReconciliation.devicePolicyReview(m.db, source.id)).policy.state, 'error');
  } finally { m.close(); }
});

test('genuine schema-10 upgrade preserves cursors, observations and frozen intents without enabling or uploading any source', async () => {
  const { m, source } = await fixture(true);
  try {
    await m.queue.enqueueSyncIntent(m.db, 'contact', source.contact_id, 'update', { notes: 'pending edit' }, new Date().toISOString(), { revision: 1, values: { notes: 'Private relationship note' } });
    await m.deviceSourceSync.enqueueDeviceSource(m.db, source, 'publish');
    m.sqlite.prepare('UPDATE sync_queue SET request_json = ?').run('{"frozen":"contact"}'); m.sqlite.prepare('UPDATE device_source_queue SET request_json = ?').run('{"frozen":"source"}');
    const contacts = pending(m), sources = pending(m, 'device_source_queue'), cursor = m.sqlite.prepare("SELECT * FROM app_metadata WHERE key = 'sync-cursor-v3'").get();
    m.sqlite.exec('DROP TABLE apple_calendar_reservations; DROP TABLE today_snooze_queue; DROP TABLE today_snoozes; DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; PRAGMA user_version = 10;');
    await m.database.migrateDatabase(m.db);
    assert.equal(m.sqlite.pragma('user_version', { simple: true }), 17); assert.deepEqual(pending(m), contacts); assert.deepEqual(pending(m, 'device_source_queue'), sources);
    assert.deepEqual(m.sqlite.prepare("SELECT * FROM app_metadata WHERE key = 'sync-cursor-v3'").get(), cursor);
    assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_policies').get().n, 0);
    assert.equal((await m.deviceContacts.listDeviceContactLinks(m.db, source.contact_id))[0].original_facts, source.original_facts);
    assert.equal((await m.deviceReconciliation.devicePolicyReview(m.db, source.id)).policy.enabled, 0);
  } finally { m.close(); }
});

test('only one local source may follow each field, while consented reads remain bounded and skip foreign and legacy entries', async () => {
  const { m, source } = await fixture();
  try {
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, await configure(m, source.id));
    const ids: string[] = [];
    for (let index = 0; index < 21; index++) {
      const id = crypto.randomUUID(); ids.push(id);
      m.sqlite.prepare(`INSERT INTO device_contact_links (id, device_contact_id, contact_id, installation_id, original_facts, observed_facts, applied_fields, observed_at, created_at, updated_at)
        SELECT ?, ?, contact_id, installation_id, json_set(original_facts, '$.device_id', ?), json_set(observed_facts, '$.device_id', ?), applied_fields, observed_at, created_at, updated_at
        FROM device_contact_links WHERE id = ?`).run(id, `entry-${index}`, `entry-${index}`, `entry-${index}`, source.id);
      if (index === 0) await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, id, await configure(m, id)), /Another iPhone source follows/);
      const review = await m.deviceReconciliation.devicePolicyReview(m.db, id);
      await m.deviceReconciliation.changeDevicePolicy(m.db, id, await configure(m, id, { name: 'keep', methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: 'keep' })) }));
    }
    const page = await m.deviceReconciliation.nextDeviceReads(m.db); assert.equal(page.length, 20);
    for (const intent of page) await m.deviceReconciliation.commitDeviceRead(m.db, intent, { state: 'unavailable' });
    assert.equal((await m.deviceReconciliation.nextDeviceReads(m.db)).length, 2); // rotate to entries not checked this hour
    m.sqlite.prepare('UPDATE device_contact_links SET installation_id = ? WHERE id = ?').run(crypto.randomUUID(), ids[0]);
    await assert.rejects(m.deviceReconciliation.devicePolicyReview(m.db, ids[0]), /original phone/);
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db, ids[0]), []);
    m.sqlite.prepare('UPDATE device_contact_links SET installation_id = NULL WHERE id = ?').run(ids[1]);
    assert.deepEqual(await m.deviceReconciliation.nextDeviceReads(m.db, ids[1]), []);
  } finally { m.close(); }
});

test('stale source choices and fields outside the accepted source audit cannot change consent or person data', async () => {
  const { m, source } = await fixture();
  try {
    const choice = await configure(m, source.id);
    await m.deviceReconciliation.changeDevicePolicy(m.db, source.id, choice);
    await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, source.id, choice), /changed/);
    const review = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, source.id, { ...await configure(m, source.id), reset: [crypto.randomUUID()] }), /accepted source fields/);
    await assert.rejects(m.deviceReconciliation.changeDevicePolicy(m.db, source.id, { ...await configure(m, source.id), expected_source_revision: source.revision + 10 }), /changed/);
    assert.deepEqual((await m.deviceReconciliation.devicePolicyReview(m.db, source.id)).policy, review.policy);
    assert.equal(pending(m).length, 0);
  } finally { m.close(); }
});

function nativeReader() {
  let permission = { granted: true, canAskAgain: false, accessPrivileges: 'limited' };
  const calls: { ids: string[]; fields: unknown[]; pages: unknown[]; prompts: number } = { ids: [], fields: [], pages: [], prompts: 0 };
  let details: Record<string, unknown> = { id: 'iphone-person', fullName: 'Ana', emails: [{ id: 'email-work', address: 'ana@example.test' }], phones: [], notes: 'never retained' };
  let page: Record<string, unknown>[] = [details], fail = false, during: (() => void) | undefined;
  class Contact {
    readonly id: string;
    constructor(id: string) { this.id = id; }
    async getDetails(fields: unknown) { calls.ids.push(this.id); calls.fields.push(fields); during?.(); if (fail) throw new Error('store failed'); return details; }
    static async presentPicker() { return new Contact('iphone-person'); }
    static async getAllDetails(fields: unknown, options: unknown) { calls.fields.push(fields); calls.pages.push(options); during?.(); return page; }
  }
  const modules: Record<string, unknown> = { 'expo-contacts': { Contact, ContactField: { FULL_NAME: 'fullName', EMAILS: 'emails', PHONES: 'phones' },
    async getPermissionsAsync() { return permission; }, async requestPermissionsAsync() { calls.prompts++; return permission = { granted: true, canAskAgain: false, accessPrivileges: 'limited' }; } },
    'react-native': { Platform: { OS: 'ios' } }, '../../../../packages/domain/src/device-contact-facts': { readDeviceContactFacts },
    '../../../../packages/domain/src/provider-sources': { ProviderSourceError }, '@/data/device-contacts': { stageDeviceContact() { throw new Error('Reader must not stage or save'); } } };
  const loaded = { exports: {} as typeof import('../apps/mobile/src/native/device-contacts') }, code = ts.transpileModule(readFileSync(new URL('../apps/mobile/src/native/device-contacts.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => { assert.ok(name in modules, name); return modules[name]; }, loaded, loaded.exports);
  return { ...loaded.exports, calls, setPermission(value: typeof permission) { permission = value; }, setDetails(value: typeof details) { details = value; }, setPage(value: typeof page) { page = value; },
    setFailure(value: boolean) { fail = value; }, duringRead(value: typeof during) { during = value; } };
}

test('recurring native reads check only the linked identity, never request permission and cannot interpret SDK failures as deletion', async () => {
  const api = nativeReader();
  const result = await api.readLinkedDeviceContact('iphone-person'); assert.equal(result.state, 'available');
  if (result.state === 'available') assert.equal(JSON.stringify(result.facts).includes('never retained'), false);
  assert.deepEqual(api.calls.ids, ['iphone-person']); assert.deepEqual(api.calls.fields, [['fullName', 'emails', 'phones']]); assert.equal(api.calls.prompts, 0);
  api.setFailure(true); assert.equal((await api.readLinkedDeviceContact('iphone-person')).state, 'unavailable');
  api.setFailure(false); api.duringRead(() => api.setPermission({ granted: false, canAskAgain: true, accessPrivileges: 'none' }));
  assert.equal((await api.readLinkedDeviceContact('iphone-person')).state, 'access_lost');
  assert.equal((await api.readLinkedDeviceContact('iphone-person')).state, 'access_lost'); assert.equal(api.calls.prompts, 0); assert.equal(api.calls.ids.length, 3);
});

test('selected capture cannot stage facts if Contacts permission changes while its details are read', async () => {
  const api = nativeReader();
  api.duringRead(() => api.setPermission({ granted: false, canAskAgain: false, accessPrivileges: 'none' }));
  await assert.rejects(api.pickDeviceContact({} as Parameters<typeof api.pickDeviceContact>[0]), /access changed/);
  assert.equal(api.calls.prompts, 0); assert.deepEqual(api.calls.ids, ['iphone-person']);
});

test('directory consent pages only allowed fields with a bounded lookahead, rejects changed permissions and never stages or imports', async () => {
  const api = nativeReader(); api.setPermission({ granted: false, canAskAgain: true, accessPrivileges: 'none' });
  await assert.rejects(api.readDeviceContactPage('', 0, false), /access is off/); assert.equal(api.calls.prompts, 0);
  api.setPage(Array.from({ length: 51 }, (_, index) => ({ id: `os-${index}`, fullName: `Person ${index}`, emails: [], phones: [], notes: 'never retained' })));
  const page = await api.readDeviceContactPage(' Ana ', 50, true); assert.equal(page.rows.length, 50); assert.equal(page.more, true); assert.equal(page.limited, true);
  assert.deepEqual(api.calls.pages, [{ name: 'Ana', offset: 50, limit: 51 }]); assert.equal(api.calls.prompts, 1); assert.equal(JSON.stringify(page).includes('never retained'), false);
  api.setPage([{ id: 'same' }, { id: 'same' }]); await assert.rejects(api.readDeviceContactPage('', 0, false), /changed during this page/);
  api.duringRead(() => api.setPermission({ granted: false, canAskAgain: false, accessPrivileges: 'none' })); await assert.rejects(api.readDeviceContactPage('', 0, false), /access changed/);
  for (const [name, offset] of [['line\nbreak', 0], ['', -1], ['', 0.5], ['', 100001]] as const) await assert.rejects(api.readDeviceContactPage(name, offset, true), /valid Contacts search/);
  assert.equal(api.calls.prompts, 1);
});

test('strict device rules reject extra keys, duplicate field identities and accidental private source metadata', async () => {
  const { m, source } = await fixture();
  try {
    const { fields } = await m.deviceReconciliation.devicePolicyReview(m.db, source.id);
    for (const bad of [{ ...fields, notes: 'private' }, { ...fields, methods: [fields.methods[0], fields.methods[0]] },
      { ...fields, methods: [{ ...fields.methods[0], slot: { ...fields.methods[0].slot, notes: 'private' } }] },
      { ...fields, name: { ...fields.name, overridden: 1 } }]) assert.throws(() => readDeviceRules(bad));
  } finally { m.close(); }
});
