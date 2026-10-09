import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { DEVICE_TOKEN_PREFIX, readNativeAccount } from '../packages/domain/src/devices.ts';
import { readDeviceContactFacts, selectedDeviceIndexes, type DeviceContactFacts } from '../packages/domain/src/device-contact-facts.ts';
import { ProviderSourceError } from '../packages/domain/src/provider-sources.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL } from '../apps/mobile/src/data/schema.ts';

const account = readNativeAccount({ deviceId: crypto.randomUUID(), userId: 'owner', workspaceId: 'test',
  email: 'owner@example.test', name: 'Owner', expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://everclosecrm.com',
  token: DEVICE_TOKEN_PREFIX + Buffer.alloc(32, 17).toString('base64url') });
function facts(overrides: Partial<DeviceContactFacts> = {}): DeviceContactFacts {
  return { device_id: 'phone-record', name: 'Device Ana', emails: [{ source_id: 'address-1', value: 'ana@example.test', label: 'Work' }],
    phones: [{ source_id: 'number-1', value: '+351 912 345 678', label: 'Mobile' }], ...overrides };
}
type Mobile = Awaited<ReturnType<typeof createMobileHarness>>;
async function choice(m: Mobile, id: string, personId?: string) {
  const review = await m.deviceContacts.deviceContactReview(m.db, id, personId);
  return { contact_id: review.target?.id ?? null, create_name: review.target ? null : review.facts.name,
    use_name: false, emails: [] as number[], phones: [] as number[],
    expected_person: review.target ? m.deviceContacts.deviceImportContactRevision(review.target) : null,
    expected_source_revision: review.link?.revision ?? null };
}
function queued(m: Mobile) { return m.sqlite.prepare('SELECT * FROM sync_queue ORDER BY rowid').all(); }

test('a genuine schema-9 upgrade preserves local source observations and receipts without uploading private provenance', async () => {
  const m = await createMobileHarness(account);
  try {
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = await choice(m, id);
    const saved = await m.deviceContacts.saveDeviceContactReview(m.db, id, input), link = (await m.deviceContacts.listDeviceContactLinks(m.db, saved.contact_id))[0];
    const preview = m.sqlite.prepare('SELECT * FROM device_contact_previews WHERE id = ?').get(id);
    const fingerprint = preview.fingerprint;
    m.sqlite.prepare('UPDATE sync_queue SET request_json = ?').run('{"original":"frozen-contact-intent"}'); const frozen = queued(m);
    m.sqlite.exec('DROP TABLE apple_calendar_publication_reviews; DROP TABLE apple_calendar_reservations; DROP TABLE today_snooze_queue; DROP TABLE today_snoozes; DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; DROP TABLE device_source_queue; DROP TABLE device_contact_links; DROP TABLE device_contact_previews; ALTER TABLE contacts DROP COLUMN device_links;');
    m.sqlite.exec(MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL);
    m.sqlite.prepare(`INSERT INTO device_contact_links (id, device_contact_id, contact_id, original_facts, observed_facts, applied_fields, revision, observed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(link.id, link.device_contact_id, link.contact_id, link.original_facts, link.observed_facts, link.applied_fields, link.revision, link.observed_at, link.created_at, link.updated_at);
    m.sqlite.prepare('INSERT INTO device_contact_previews (id, facts, created_at, fingerprint, source_id, contact_id, epoch) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(preview.id, preview.facts, preview.created_at, fingerprint, preview.source_id, preview.contact_id, preview.epoch);
    m.sqlite.prepare("INSERT INTO app_metadata (key, value, updated_at) VALUES ('sync-cursor-v3', ?, ?)").run(JSON.stringify({ epoch: crypto.randomUUID(), sequence: 15 }), new Date().toISOString());
    m.sqlite.pragma('user_version = 9'); await m.database.migrateDatabase(m.db);
    const migrated = (await m.deviceContacts.listDeviceContactLinks(m.db, saved.contact_id))[0];
    assert.equal(migrated.installation_id, null); assert.equal(migrated.shared, 0); assert.equal(migrated.cloud_revision, null);
    for (const key of ['id', 'device_contact_id', 'contact_id', 'original_facts', 'observed_facts', 'applied_fields', 'revision'] as const) assert.equal(migrated[key], link[key]);
    assert.deepEqual(queued(m), frozen); assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_source_queue').get().n, 0);
    assert.deepEqual(await m.deviceContacts.saveDeviceContactReview(m.db, id, input), saved);
    assert.equal(m.sqlite.prepare('SELECT fingerprint FROM device_contact_previews WHERE id = ?').get(id).fingerprint, fingerprint);
    await assert.rejects(m.deviceContacts.shareDeviceContact(m.db, migrated), /Choose this contact again/);
    assert.equal(m.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v3'").get(), undefined);
  } finally { m.close(); }
});

test('device facts retain only bounded selected-contact fields and reject accidental private metadata', () => {
  assert.deepEqual(readDeviceContactFacts(JSON.stringify(facts({ name: '  Ana  ' }))).name, 'Ana');
  for (const value of [null, { ...facts(), notes: 'Private OS note' }, { ...facts(), name: 'x'.repeat(201) },
    facts({ emails: [{ source_id: null, value: 'mail\nheader', label: null }] }), facts({ phones: Array(101).fill(facts().phones[0]) }),
    facts({ emails: Array(100).fill({ source_id: 'x'.repeat(500), value: 'ana@example.test', label: null }) }),
    { ...facts(), phones: [{ ...facts().phones[0], photo: 'accidental' }] }]) assert.throws(() => readDeviceContactFacts(value));
  assert.deepEqual(selectedDeviceIndexes([3, 0, 1]), [0, 1, 3]);
  for (const value of [[1, 1], [-1], [100], [0.5], null]) assert.throws(() => selectedDeviceIndexes(value));
});

test('selected capture creates one person with reviewed methods and immutable original facts; exact retries survive reopening', async () => {
  const m = await createMobileHarness(account);
  try {
    const observed = facts({ emails: [...facts().emails, { source_id: 'address-2', value: 'other@example.test', label: 'Home' }] });
    const preview = await m.deviceContacts.stageDeviceContact(m.db, observed);
    const input = { ...await choice(m, preview), create_name: 'My Ana', emails: [0], phones: [0] };
    const saved = await m.deviceContacts.saveDeviceContactReview(m.db, preview, input);
    assert.equal(saved.contact_id, preview); assert.equal(queued(m).length, 1);
    const person = (await m.contacts.getContact(m.db, saved.contact_id))!;
    assert.equal(person.name, 'My Ana'); assert.equal(person.email, 'ana@example.test'); assert.equal(person.phone, '+351 912 345 678');
    assert.equal(JSON.parse(person.contact_methods).length, 2); assert.equal(person.notes, null);
    const source = (await m.deviceContacts.listDeviceContactLinks(m.db, person.id))[0];
    assert.deepEqual(JSON.parse(source.original_facts), observed);
    assert.equal(JSON.parse(source.applied_fields).name, null); assert.equal(JSON.parse(source.applied_fields).methods.length, 2);
    const reopened = await createMobileHarness(account, m.sqlite);
    assert.deepEqual(await reopened.deviceContacts.saveDeviceContactReview(reopened.db, preview, input), saved);
    const receipt = await reopened.deviceContacts.deviceContactReview(reopened.db, preview);
    assert.equal(receipt.completed, true); assert.equal(receipt.saved?.id, person.id); assert.equal(queued(m).length, 1);
    await assert.rejects(reopened.deviceContacts.saveDeviceContactReview(reopened.db, preview, { ...input, emails: [1] }), /different choices/);
  } finally { m.close(); }
});

test('email and international phone matches are suggestions; names and countryless local numbers never auto-attach', async () => {
  const m = await createMobileHarness(account);
  try {
    const a = await m.contacts.createContact(m.db, { name: 'First Ana', email: 'ANA@example.test' });
    const b = await m.contacts.createContact(m.db, { name: 'Other Ana', email: 'ana@example.test' });
    const c = await m.contacts.createContact(m.db, { name: 'Phone match', phone: '+351912345678' });
    await m.contacts.createContact(m.db, { name: 'Device Ana', phone: '912345678' });
    const preview = await m.deviceContacts.stageDeviceContact(m.db, facts());
    const review = await m.deviceContacts.deviceContactReview(m.db, preview);
    assert.deepEqual(review.matches.map((person) => person.id).sort(), [a.id, b.id, c.id].sort());
    assert.equal(review.target, null); assert.equal(review.linked, null); assert.equal(queued(m).length, 4);
    const local = await m.deviceContacts.stageDeviceContact(m.db, facts({ emails: [], phones: [{ source_id: null, value: '912345678', label: null }] }));
    assert.equal((await m.deviceContacts.deviceContactReview(m.db, local)).matches.length, 0);
    assert.equal((await m.deviceContacts.deviceContactReview(m.db, preview, undefined, 'Other')).people[0].id, b.id);
  } finally { m.close(); }
});

test('attaching selected values preserves private fields, existing method identities, labels and preferred methods', async () => {
  const m = await createMobileHarness(account);
  try {
    const person = await m.contacts.createContact(m.db, { name: 'My name', email: 'preferred@example.test', phone: '+351900000001', notes: 'Private memory', contactFrequency: 30 });
    m.sqlite.prepare('UPDATE contacts SET birthday = ?, how_we_met = ?, last_contacted = ? WHERE id = ?').run('1990-02-03', 'Private story', '2026-09-01', person.id);
    const before = (await m.contacts.getContact(m.db, person.id))!;
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts());
    await m.deviceContacts.saveDeviceContactReview(m.db, id, { ...await choice(m, id, person.id), emails: [0], phones: [0] });
    const after = (await m.contacts.getContact(m.db, person.id))!;
    for (const field of ['name', 'email', 'phone', 'notes', 'birthday', 'how_we_met', 'last_contacted', 'contact_frequency'] as const) assert.equal(after[field], before[field]);
    const methods = JSON.parse(after.contact_methods);
    for (const original of JSON.parse(before.contact_methods)) assert.deepEqual(methods.find((method: { id: string }) => method.id === original.id), original);
    assert.equal(methods.length, 4); assert.equal(methods.filter((method: { preferred: boolean }) => method.preferred).length, 2);
    assert.deepEqual(Object.keys(JSON.parse(queued(m).at(-1).payload)), ['contact_methods']);
  } finally { m.close(); }
});

test('source-only and duplicate-field reviews do not enqueue a contact write; later observations retain original facts', async () => {
  const m = await createMobileHarness(account);
  try {
    const person = await m.contacts.createContact(m.db, { name: 'My name', email: 'ana@example.test' });
    // Cloud projections can encode the same methods in a different key order.
    const original = (await m.contacts.getContact(m.db, person.id))!;
    m.sqlite.prepare('UPDATE contacts SET contact_methods = ? WHERE id = ?').run(JSON.stringify(JSON.parse(original.contact_methods).map((method: { id: string }) => ({ ...method, id: method.id })), null, 2), person.id);
    const count = queued(m).length;
    const first = await m.deviceContacts.stageDeviceContact(m.db, facts());
    await m.deviceContacts.saveDeviceContactReview(m.db, first, await choice(m, first, person.id));
    const before = (await m.contacts.getContact(m.db, person.id))!;
    const next = await m.deviceContacts.stageDeviceContact(m.db, facts({ name: 'Later device name' }));
    await m.deviceContacts.saveDeviceContactReview(m.db, next, { ...await choice(m, next, person.id), emails: [0] });
    assert.equal(queued(m).length, count); assert.deepEqual(await m.contacts.getContact(m.db, person.id), before);
    const source = (await m.deviceContacts.listDeviceContactLinks(m.db, person.id))[0];
    assert.equal(source.revision, 2); assert.equal(JSON.parse(source.original_facts).name, 'Device Ana');
    assert.equal(JSON.parse(source.observed_facts).name, 'Later device name');
    assert.equal(JSON.parse(source.applied_fields).methods[0].method.id, JSON.parse(original.contact_methods)[0].id);
  } finally { m.close(); }
});

test('stale person or source choices and rebinding a linked source roll back without changing fields or receipts', async () => {
  const m = await createMobileHarness(account);
  try {
    const person = await m.contacts.createContact(m.db, { name: 'Ana', notes: 'Opening note' });
    const other = await m.contacts.createContact(m.db, { name: 'Other' });
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = { ...await choice(m, id, person.id), use_name: true, emails: [0] };
    m.sqlite.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run('Later note', person.id);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, input), /person changed/);
    assert.equal((await m.contacts.getContact(m.db, person.id))!.name, 'Ana'); assert.equal(queued(m).length, 2);
    assert.equal(m.sqlite.prepare('SELECT fingerprint FROM device_contact_previews WHERE id = ?').get(id).fingerprint, null);
    await m.deviceContacts.saveDeviceContactReview(m.db, id, { ...await choice(m, id, person.id), emails: [0] });
    const second = await m.deviceContacts.stageDeviceContact(m.db, facts());
    const stale = await choice(m, second, person.id);
    m.sqlite.prepare('UPDATE device_contact_links SET revision = revision + 1').run();
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, second, stale), /source is already linked or changed/);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, second, await choice(m, second, other.id)), /already linked/);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, second, await choice(m, second)), /already linked/);
    assert.equal((await m.contacts.getContact(m.db, other.id))!.email, null);
  } finally { m.close(); }
});

test('method validation and transaction failures never publish a partial person, source or outbox mutation', async () => {
  const m = await createMobileHarness(account);
  try {
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = { ...await choice(m, id), emails: [0] };
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, { ...input, phones: [99] }), /source field/);
    m.faults.sqlContains = 'UPDATE device_contact_previews SET fingerprint';
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, input), /write failure/);
    for (const table of ['contacts', 'device_contact_links', 'sync_queue']) assert.equal(m.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    assert.equal(m.sqlite.prepare('SELECT fingerprint FROM device_contact_previews').get().fingerprint, null);
    delete m.faults.sqlContains;
    await m.deviceContacts.saveDeviceContactReview(m.db, id, input); assert.equal(queued(m).length, 1);
  } finally { m.close(); }
});

test('unlink retains the person and accepted methods and prevents a saved receipt from recreating its source', async () => {
  const m = await createMobileHarness(account);
  try {
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = { ...await choice(m, id), emails: [0], phones: [0] };
    const saved = await m.deviceContacts.saveDeviceContactReview(m.db, id, input);
    const before = (await m.contacts.getContact(m.db, saved.contact_id))!;
    const source = (await m.deviceContacts.listDeviceContactLinks(m.db, before.id))[0];
    await m.deviceContacts.unlinkDeviceContact(m.db, source);
    const after = (await m.contacts.getContact(m.db, before.id))!;
    assert.equal(after.device_contact_id, null); assert.equal(after.contact_methods, before.contact_methods); assert.equal(queued(m).length, 1);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, input), /no longer available/);
    const receipt = await m.deviceContacts.deviceContactReview(m.db, id); assert.equal(receipt.completed, true); assert.equal(receipt.saved, null);
    await assert.rejects(m.deviceContacts.unlinkDeviceContact(m.db, source), /source changed/);
  } finally { m.close(); }
});

test('deleted parents retain source details until explicit unlink and exact retries never resurrect the person', async () => {
  const m = await createMobileHarness(account);
  try {
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = await choice(m, id);
    const saved = await m.deviceContacts.saveDeviceContactReview(m.db, id, input);
    m.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), saved.contact_id);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, input), /no longer available/);
    const next = await m.deviceContacts.stageDeviceContact(m.db, facts());
    const review = await m.deviceContacts.deviceContactReview(m.db, next); assert.equal(review.retired, true); assert.ok(review.link);
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, next, await choice(m, next)), /already linked/);
    await m.deviceContacts.unlinkDeviceContact(m.db, review.link!);
    const recreated = await m.deviceContacts.saveDeviceContactReview(m.db, next, await choice(m, next));
    assert.notEqual(recreated.contact_id, saved.contact_id); assert.equal((await m.contacts.listContacts(m.db)).length, 1);
  } finally { m.close(); }
});

test('restore fences an unsaved review and schema-8 upgrade preserves frozen requests and resets the projection cursor', async () => {
  const m = await createMobileHarness(account);
  try {
    const cursor = JSON.stringify({ epoch: crypto.randomUUID(), sequence: 10 });
    m.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('sync-cursor-v3', cursor, new Date().toISOString());
    await m.contacts.createContact(m.db, { name: 'Offline draft', notes: 'Private' });
    m.sqlite.prepare('UPDATE sync_queue SET request_json = ?').run('{"frozen":"keep-exact"}');
    const frozen = queued(m);
    m.sqlite.exec('DROP TABLE apple_calendar_publication_reviews; DROP TABLE apple_calendar_reservations; DROP TABLE today_snooze_queue; DROP TABLE today_snoozes; DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; DROP TABLE calendar_events; DROP TRIGGER device_policy_after_edit; DROP TRIGGER device_policy_after_move; DROP TABLE device_contact_policies; DROP TABLE device_source_queue; ALTER TABLE contacts DROP COLUMN device_links; DROP TABLE device_contact_links; DROP TABLE device_contact_previews; PRAGMA user_version = 8');
    await m.database.migrateDatabase(m.db);
    assert.equal(m.sqlite.pragma('user_version', { simple: true }), 18); assert.deepEqual(queued(m), frozen);
    assert.equal(m.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v3'").get(), undefined);
    m.sqlite.prepare("INSERT INTO app_metadata (key, value, updated_at) VALUES ('sync-cursor-v3', ?, ?)").run(cursor, new Date().toISOString());
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts()), input = await choice(m, id);
    m.sqlite.prepare("UPDATE app_metadata SET value = ? WHERE key = 'sync-cursor-v3'").run(JSON.stringify({ epoch: crypto.randomUUID(), sequence: 0 }));
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, input), /data was restored/);
    assert.deepEqual(queued(m), frozen); assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_links').get().n, 0);
  } finally { m.close(); }
});

test('bounded previews expire only unfinished reviews and a per-person source cap rolls back the entire attempted import', async () => {
  const m = await createMobileHarness(account);
  try {
    const person = await m.contacts.createContact(m.db, { name: 'Ana' });
    for (let i = 0; i < 32; i++) {
      const id = await m.deviceContacts.stageDeviceContact(m.db, facts({ device_id: `phone-${i}` }));
      await m.deviceContacts.saveDeviceContactReview(m.db, id, await choice(m, id, person.id));
    }
    const id = await m.deviceContacts.stageDeviceContact(m.db, facts({ device_id: 'phone-33' }));
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, { ...await choice(m, id, person.id), use_name: true, emails: [0] }), /source limit/);
    assert.equal(queued(m).length, 1); assert.equal((await m.contacts.getContact(m.db, person.id))!.name, 'Ana');
    assert.equal((await m.deviceContacts.listDeviceContactLinks(m.db, person.id)).length, 32);
    for (let i = 0; i < 19; i++) await m.deviceContacts.stageDeviceContact(m.db, facts({ device_id: `pending-${i}` }));
    await assert.rejects(m.deviceContacts.stageDeviceContact(m.db, facts()), /earlier device contact review/);
    m.sqlite.prepare("UPDATE device_contact_previews SET created_at = '2020-01-01T00:00:00.000Z'").run();
    await m.deviceContacts.stageDeviceContact(m.db, facts());
    assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_previews WHERE fingerprint IS NULL').get().n, 1);
    assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_previews WHERE fingerprint IS NOT NULL').get().n, 32);
  } finally { m.close(); }
});

test('the native picker checks permission and reads only the selected person; cancellation, denial and inaccessible limited contacts never save', async () => {
  const m = await createMobileHarness(account);
  try {
    const loaded = { exports: {} as typeof import('../apps/mobile/src/native/device-contacts') };
    const requests: unknown[] = [];
    let canceled = false, unreadable = false, pickerCalls = 0, permissionRequests = 0;
    let permission = { granted: false, canAskAgain: true, accessPrivileges: 'none' };
    const modules: Record<string, unknown> = {
      'expo-contacts': { async getPermissionsAsync() { return permission; }, async requestPermissionsAsync() { permissionRequests++; permission = { granted: true, canAskAgain: false, accessPrivileges: 'limited' }; return permission; },
        ContactField: { FULL_NAME: 'fullName', EMAILS: 'emails', PHONES: 'phones' }, Contact: { async presentPicker() {
        pickerCalls++;
        return canceled ? null : { id: 'selected-os-record', async getDetails(fields: unknown) { if (unreadable) throw new Error('Outside limited selection'); requests.push(fields); return { fullName: 'Selected Ana',
          emails: [{ id: 'chosen-email', address: 'ana@example.test', label: 'Home' }, {}], phones: [{ id: 'chosen-phone', number: '+351912345678' }],
          notes: 'Never retained', image: 'Never retained', addresses: ['Never retained'] }; } };
      } } },
      'react-native': { Platform: { OS: 'ios' } },
      '../../../../packages/domain/src/device-contact-facts': { readDeviceContactFacts },
      '../../../../packages/domain/src/provider-sources': { ProviderSourceError },
      '@/data/device-contacts': { stageDeviceContact: m.deviceContacts.stageDeviceContact },
    };
    const code = ts.transpileModule(readFileSync(new URL('../apps/mobile/src/native/device-contacts.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'module', 'exports', code)((name: string) => { assert.ok(name in modules, name); return modules[name]; }, loaded, loaded.exports);
    const id = await loaded.exports.pickDeviceContact(m.db); assert.ok(id);
    const review = await m.deviceContacts.deviceContactReview(m.db, id);
    assert.deepEqual(requests, [['fullName', 'emails', 'phones']]); assert.equal(review.facts.device_id, 'selected-os-record');
    assert.equal(review.facts.emails.length, 1); assert.equal(JSON.stringify(review.facts).includes('Never retained'), false);
    assert.equal(queued(m).length, 0); canceled = true; assert.equal(await loaded.exports.pickDeviceContact(m.db), null);
    assert.equal(requests.length, 1); assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_previews').get().n, 1);
    canceled = false; unreadable = true;
    await assert.rejects(loaded.exports.pickDeviceContact(m.db), /Manage allowed contacts/);
    permission = { granted: false, canAskAgain: false, accessPrivileges: 'none' };
    await assert.rejects(loaded.exports.pickDeviceContact(m.db), /access is off/);
    assert.equal(permissionRequests, 1); assert.equal(pickerCalls, 3); assert.equal(requests.length, 1);
    assert.equal(m.sqlite.prepare('SELECT COUNT(*) n FROM device_contact_previews').get().n, 1);
  } finally { m.close(); }
});

test('large original and observed source details stop at the byte limit without adding fields or losing an earlier source', async () => {
  const m = await createMobileHarness(account);
  try {
    const person = await m.contacts.createContact(m.db, { name: 'My Ana' });
    const emails = Array.from({ length: 80 }, (_, index) => ({ source_id: `${index}-` + 's'.repeat(78),
      value: `${index}.` + 'a'.repeat(70) + '@example.test', label: 'l'.repeat(70) }));
    const large = facts({ emails, phones: [] }); assert.ok(Buffer.byteLength(JSON.stringify(large)) < 24576);
    for (let i = 0; i < 2; i++) {
      const id = await m.deviceContacts.stageDeviceContact(m.db, { ...large, device_id: `large-${i}` });
      await m.deviceContacts.saveDeviceContactReview(m.db, id, await choice(m, id, person.id));
    }
    const before = await m.deviceContacts.listDeviceContactLinks(m.db, person.id);
    const id = await m.deviceContacts.stageDeviceContact(m.db, { ...large, device_id: 'large-overflow' });
    await assert.rejects(m.deviceContacts.saveDeviceContactReview(m.db, id, { ...await choice(m, id, person.id), emails: [0], use_name: true }), /source limit/);
    assert.deepEqual(await m.deviceContacts.listDeviceContactLinks(m.db, person.id), before);
    assert.equal(queued(m).length, 1); const unchanged = (await m.contacts.getContact(m.db, person.id))!;
    assert.equal(unchanged.name, 'My Ana'); assert.equal(unchanged.contact_methods, '[]');
    assert.equal(m.sqlite.prepare('SELECT fingerprint FROM device_contact_previews WHERE id = ?').get(id).fingerprint, null);
  } finally { m.close(); }
});
