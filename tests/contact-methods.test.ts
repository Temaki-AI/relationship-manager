import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { contactMethodIdentity, readContactMethods, normalizeUserContactMethods, replacePrimaryContactMethods, reviewContactMethodsPatch, displayContactMethodLabel, describeContactMethods } from '../packages/domain/src/contact-methods.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { readPushResultV3 } from '../packages/domain/src/sync-v3-client.ts';
const method = (value: string, kind = 'email', preferred = true) => ({ id: crypto.randomUUID(), kind, value, label: 'Work', country: null, preferred });

test('Apple contact labels display clearly while source and unsaved editor labels retain their exact values', () => {
  assert.equal(displayContactMethodLabel('_$!<Work>!$_'), 'Work');
  assert.equal(displayContactMethodLabel('_$!<Home>!$_'), 'Home');
  assert.equal(displayContactMethodLabel('_$!<Mobile>!$_'), 'Mobile');
  assert.equal(displayContactMethodLabel('_$!<iPhone>!$_'), 'iPhone');
  assert.equal(displayContactMethodLabel('_$!<WorkFAX>!$_'), 'Work fax');
  for (const custom of ['Work', 'Office — Lisboa', '_$!<My custom label>!$_', 'prefix _$!<Work>!$_', '', 'constructor']) {
    assert.equal(displayContactMethodLabel(custom), custom);
  }
  assert.equal(displayContactMethodLabel(null), null);
  assert.equal(displayContactMethodLabel(undefined), null);
  const stored = normalizeUserContactMethods([{ ...method('source@example.invalid'), label: '_$!<Work>!$_' }]);
  const editorDraft = readContactMethods(stored);
  assert.equal(displayContactMethodLabel(editorDraft[0].label), 'Work');
  assert.equal(editorDraft[0].label, '_$!<Work>!$_');
  assert.equal(describeContactMethods(stored), 'Work: source@example.invalid (preferred)');
  assert.equal(normalizeUserContactMethods(editorDraft, stored), stored, 'Displaying a label must not silently rewrite it on save');
});

test('method normalization preserves raw values and country context, rejects unsafe links, and inherits provenance only from guarded original data', () => {
  const email = method('Ána@Example.test'), phone = { ...method('912 345 678', 'phone'), country: 'PT' };
  const normalized = readContactMethods(normalizeUserContactMethods([email, phone]));
  assert.equal(normalized[0].source, 'manual'); assert.ok(normalized.every((item) => item.user_override));
  assert.equal(contactMethodIdentity(normalized.find((item) => item.kind === 'email')!), 'email::ána@example.test');
  assert.notEqual(contactMethodIdentity({ kind: 'phone', value: '912345678', country: 'PT' }), contactMethodIdentity({ kind: 'phone', value: '912345678', country: 'BR' }));
  assert.equal(contactMethodIdentity({ kind: 'phone', value: '+351 (912) 345-678', country: null }), 'phone::+351912345678');
  const legacy = [{ ...email, source: 'legacy', source_value: email.value, user_override: false }];
  const edited = readContactMethods(normalizeUserContactMethods([{ ...legacy[0], value: 'new@example.test', source: 'fake', source_value: 'forged', user_override: false }], JSON.stringify(legacy)))[0];
  assert.equal(edited.source, 'legacy'); assert.equal(edited.source_value, email.value); assert.equal(edited.user_override, true);
  assert.throws(() => normalizeUserContactMethods([method('javascript:alert(1)', 'profile')]));
  assert.throws(() => normalizeUserContactMethods([method('https://user:password@example.test', 'profile')]));
  assert.throws(() => normalizeUserContactMethods([email, { ...email, value: 'other@example.test' }]));
  assert.throws(() => normalizeUserContactMethods([email, method('second@example.test')]));
  const untouched = method('other@example.test', 'email', false);
  const reviewed = readContactMethods(reviewContactMethodsPatch(JSON.stringify(normalized), normalizeUserContactMethods(normalized.map((item) => item.id === email.id ? { ...item, value: 'reviewed@example.test' } : item), JSON.stringify(normalized)), normalizeUserContactMethods([...normalized, untouched])));
  assert.equal(reviewed.find((item) => item.id === untouched.id)?.value, untouched.value);
});

test('migration backfills primary, vCard and social methods without renumbering people or replaying old history', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  try {
    for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql') && name < '0029').sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    db.prepare("INSERT INTO workspaces (id, name) VALUES ('test', 'Test')").run();
    db.prepare('INSERT INTO contacts (id, workspace_id, name, email, phone, custom_fields) VALUES (?, ?, ?, ?, ?, ?)').run(41, 'test', 'Ana', 'ana@example.test', '+351912345678', JSON.stringify({ vcard: { additional_emails: ['work@example.test'] }, social: { linkedin: 'https://www.linkedin.com/in/ana' } }));
    const before = db.prepare('SELECT public_id FROM contacts').get().public_id, sequence = db.prepare('SELECT count(*) n FROM sync_changes').get().n;
    db.exec(readFileSync(new URL('../drizzle/0029_contact_methods.sql', import.meta.url), 'utf8'));
    assert.equal(db.prepare('SELECT public_id FROM contacts').get().public_id, before);
    assert.equal(db.prepare('SELECT count(*) n FROM sync_changes').get().n, sequence);
    const row = db.prepare('SELECT * FROM contacts').get(), methods = readContactMethods(row.contact_methods);
    assert.equal(methods.length, 4); assert.ok(methods.every((item) => item.source === 'legacy' && !item.user_override));
    const first = methods.find((item) => item.kind === 'email' && item.preferred)!;
    db.prepare('UPDATE contacts SET email = ? WHERE id = 41').run('changed@example.test');
    const changed = readContactMethods(db.prepare('SELECT contact_methods FROM contacts').get().contact_methods).find((item) => item.id === first.id)!;
    assert.equal(changed.value, 'changed@example.test'); assert.equal(changed.source_value, 'ana@example.test'); assert.equal(changed.user_override, true);
    for (const invalid of ['{}', '[{}]', 'not json', JSON.stringify([{ ...changed, preferred: 1 }])]) assert.throws(() => db.prepare('UPDATE contacts SET contact_methods = ? WHERE id = 41').run(invalid), /CONTACT_METHODS_INVALID/);
  } finally { db.close(); }
});

test('self-hosted methods preserve preferred values, original provenance and secondary addresses across initialization', () => {
  const db = new Database(':memory:');
  try {
    initializeDatabase(db); const id = db.prepare('INSERT INTO contacts (name, email) VALUES (?, ?)').run('Ana', 'ana@example.test').lastInsertRowid;
    const original = db.prepare('SELECT contact_methods FROM contacts WHERE id = ?').get(id).contact_methods;
    const methods = readContactMethods(original), extra = method('work@example.test', 'email', false);
    const value = normalizeUserContactMethods([...methods, extra], original);
    db.prepare('UPDATE contacts SET contact_methods = ? WHERE id = ?').run(value, id);
    initializeDatabase(db); assert.equal(db.prepare('SELECT contact_methods FROM contacts WHERE id = ?').get(id).contact_methods, value);
    const selected = normalizeUserContactMethods(readContactMethods(value).map((item) => ({ ...item, preferred: item.id === extra.id })), value);
    db.prepare('UPDATE contacts SET contact_methods = ? WHERE id = ?').run(selected, id);
    assert.equal(db.prepare('SELECT email FROM contacts WHERE id = ?').get(id).email, 'work@example.test');
    const cleared = replacePrimaryContactMethods(selected, { email: null }, crypto.randomUUID);
    db.prepare('UPDATE contacts SET contact_methods = ? WHERE id = ?').run(cleared, id);
    assert.equal(db.prepare('SELECT email FROM contacts WHERE id = ?').get(id).email, null);
    assert.equal(readContactMethods(cleared).length, 1);
  } finally { db.close(); }
});

test('cloud web methods, search, sync CAS and recovery keep stable identities and exact receipts while refusing stale collections', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ana', email: 'ana@example.test' } })).body.contact;
    const initial = await h.call(`contacts/${contact.id}`), extra = method('secondary@example.test', 'email', false);
    const saved = await h.call(`contacts/${contact.id}`, { method: 'PATCH', body: { contact_methods: [...readContactMethods(initial.body.contact.contact_methods), extra], expected_edit_revision: initial.body.contact.edit_revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await h.call('contacts?search=secondary%40example.test')).body.contacts[0].id, contact.id);
    assert.equal((await h.call(`contacts/${contact.id}`, { method: 'PATCH', body: { contact_methods: [], expected_edit_revision: initial.body.contact.edit_revision } })).status, 409);
    const bootstrap = (await h.call('v3/sync/bootstrap')).body, record = bootstrap.records[0];
    const mutation = { operationId: crypto.randomUUID(), entity: 'contact', entityId: contact.public_id, type: 'update', baseRevision: record.revision,
      base: { contact_methods: record.data.contact_methods }, patch: { contact_methods: readContactMethods(record.data.contact_methods).map((item) => ({ ...item, preferred: item.id === extra.id })) } };
    const body = { version: 3, epoch: bootstrap.cursor.epoch, mutation };
    const changed = await h.call('v3/sync/push', { method: 'POST', body }); assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(readPushResultV3(changed.body, mutation.operationId, 'contact', contact.public_id).status, 'applied');
    assert.equal(changed.body.result.record.data.email, extra.value);
    assert.equal((await h.call('v3/sync/push', { method: 'POST', body })).body.replayed, true);
    const forged = await h.call('v3/sync/push', { method: 'POST', body: { ...body, mutation: { ...mutation, operationId: crypto.randomUUID(), baseRevision: changed.body.result.record.revision, base: { contact_methods: '[]' } } } });
    assert.equal(forged.status, 200); assert.equal(forged.body.result.status, 'conflict');
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    const restored = (await h.call('v3/sync/bootstrap')).body.records[0];
    assert.equal(restored.data.contact_methods, changed.body.result.record.data.contact_methods);
    assert.equal(restored.data.email, extra.value);
    assert.equal((await h.call('contacts', { workspace: 'other' })).body.contacts.length, 0);
  } finally { await h.close(); }
});

test('CSV and vCard preserve multiple labeled methods, countries and intentional clearing without restoring legacy secondary values', async () => {
  const { CONTACT_CSV_HEADERS, serializeContactToCSVRow } = await import('../lib/contact-export.ts');
  const { serializeContactToVCard, parseVCards, normalizeVCardContact } = await import('../lib/vcard.ts');
  const { parseImportPreview } = await import('../lib/import-preview.ts');
  const db = new Database(':memory:');
  try {
    initializeDatabase(db);
    const methods = normalizeUserContactMethods([method('person@example.test'), method('second@example.test', 'email', false),
      { ...method('912 345 678', 'phone'), country: 'PT', label: 'Personal phone' },
      { ...method('912 345 678', 'phone', false), country: 'BR', label: 'Travel phone' },
      { ...method('https://example.test/profile?a=1&b=2', 'profile'), label: 'My profile, favorite' }]);
    const metadata = JSON.stringify({ vcard: { additional_emails: ['removed@example.test'] }, social: { website: 'https://example.test/removed' } });
    const id = db.prepare('INSERT INTO contacts (name, contact_methods, custom_fields) VALUES (?, ?, ?)').run('Portable person', methods, metadata).lastInsertRowid;
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as import('../lib/db.ts').Contact;
    const csv = CONTACT_CSV_HEADERS.join(',') + '\n' + serializeContactToCSVRow(contact);
    const csvPayload = JSON.parse(parseImportPreview(csv, 'csv', '2026-10-03T12:00:00Z')[0].payload!);
    assert.deepEqual(readContactMethods(csvPayload.contact_methods), readContactMethods(methods));
    const vcard = serializeContactToVCard(contact);
    assert.ok(!vcard.includes('EMAIL;TYPE=OTHER:removed@example.test'));
    assert.ok(!vcard.includes('X-SOCIALPROFILE;TYPE=website:https://example.test/removed'));
    assert.equal(vcard.match(/TEL;TYPE=/gu)?.length, 2);
    assert.deepEqual(readContactMethods(normalizeVCardContact(parseVCards(vcard)[0]).contact_methods), readContactMethods(methods));
    const standard = normalizeVCardContact(parseVCards('BEGIN:VCARD\nFN:Standard\nEMAIL;TYPE=WORK:work@example.test\nEMAIL;TYPE=HOME,PREF:home@example.test\nTEL;TYPE=CELL;X-EVERCLOSE-COUNTRY=PT:912 345 678\nURL:https://example.test/one\nURL:https://example.test/two\nEND:VCARD')[0]);
    assert.equal(standard.email, 'home@example.test');
    assert.equal(readContactMethods(standard.contact_methods).length, 5);
    assert.equal(readContactMethods(standard.contact_methods).find((item) => item.kind === 'phone')!.country, 'PT');
    db.prepare("UPDATE contacts SET contact_methods = '[]' WHERE id = ?").run(id);
    const cleared = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as import('../lib/db.ts').Contact;
    assert.equal(cleared.contact_methods, '[]'); assert.equal(cleared.email, null); assert.equal(cleared.phone, null);
    const normalized = normalizeVCardContact(parseVCards(serializeContactToVCard(cleared))[0]);
    const copy = db.prepare('INSERT INTO contacts (name, contact_methods, custom_fields) VALUES (?, ?, ?)').run(normalized.name, normalized.contact_methods, normalized.custom_fields).lastInsertRowid;
    assert.equal(db.prepare('SELECT contact_methods FROM contacts WHERE id = ?').get(copy).contact_methods, '[]');
  } finally { db.close(); }
});

test('import and duplicate suggestions include secondary methods without equating local numbers from different countries', async () => {
  const { getContactIdentityKeys } = await import('../lib/contact-import.ts');
  const { getDuplicateSignals } = await import('../lib/contact-merge.ts');
  const contact = (country: string | null, value = '912 345 678') => ({ name: `Person ${country}`, email: null, phone: value, birthday: null, custom_fields: null,
    contact_methods: normalizeUserContactMethods([{ ...method(value, 'phone'), country }, method('secondary@example.test', 'email', false)]) });
  const pt = getContactIdentityKeys(contact('PT')), br = getContactIdentityKeys(contact('BR'));
  assert.ok(pt.includes('email:secondary@example.test'));
  assert.ok(!pt.filter((key) => key.startsWith('phone:')).some((key) => br.includes(key)));
  assert.deepEqual(pt, getDuplicateSignals(contact('PT')).map((item) => item.key));
  assert.deepEqual(pt, getContactIdentityKeys(contact('PT', '912345678')));
  assert.notDeepEqual(pt, getContactIdentityKeys(contact(null)));
  const international = (country: string) => getContactIdentityKeys(contact(country, '+351912345678'));
  assert.deepEqual(international('PT'), international('BR'));
});

test('cloud import reviews secondary-address matches and keeps distinct phone countries in separate records', async () => {
  const h = await createCloudHarness();
  try {
    const { escapeCSVField } = await import('../lib/csv.ts');
    const existingMethods = normalizeUserContactMethods([method('secondary@example.test', 'email', false), { ...method('912 345 678', 'phone'), country: 'PT' }]);
    const existing = await h.call('contacts', { method: 'POST', body: { name: 'Existing', contact_methods: existingMethods } });
    assert.equal(existing.status, 201, JSON.stringify(existing.body));
    const source = 'Name,Contact Methods\n' + [
      ['Mail match', normalizeUserContactMethods([method('secondary@example.test')])],
      ['Other country', normalizeUserContactMethods([{ ...method('912345678', 'phone'), country: 'BR' }])],
      ['Same country', normalizeUserContactMethods([{ ...method('912345678', 'phone'), country: 'PT' }])],
    ].map((row) => row.map(escapeCSVField).join(',')).join('\n');
    const form = new FormData(); form.set('file', new File([source], 'methods.csv'));
    const uploaded = await h.call('import/csv', { method: 'POST', form }); assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const id = uploaded.body.job.id;
    const act = (action: string, extra = {}) => h.call(`import/jobs/${id}`, { method: 'POST', body: { action, ...extra } });
    const preview = await act('prepare'); assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.counts.review, 2); assert.equal(preview.body.counts.ready, 1);
    assert.equal(preview.body.rows[0].matches[0].id, existing.body.contact.id);
    await act('skip-matches'); await act('confirm', { confirm: true }); const result = await act('advance');
    assert.equal(result.body.counts.imported, 1, JSON.stringify(result.body));
    const saved = (await h.call('contacts?search=Other%20country')).body.contacts[0];
    const detail = (await h.call(`contacts/${saved.id}`)).body.contact;
    assert.equal(readContactMethods(detail.contact_methods)[0].country, 'BR');
    assert.equal((await h.call('contacts', { workspace: 'other' })).body.contacts.length, 0);
  } finally { await h.close(); }
});

test('explicit review maps provisional legacy cache methods only to one current value and preserves its metadata and preferred choice', () => {
  const old = { ...method('original@example.test'), source: 'legacy' as const, source_value: 'original@example.test', user_override: false };
  const chosen = { ...method(old.value, 'email', false), label: 'Cloud label' };
  const newer = method('new-primary@example.test');
  const current = normalizeUserContactMethods([chosen, newer]);
  const draft = normalizeUserContactMethods([{ ...old, value: 'reviewed@example.test' }], JSON.stringify([old]));
  const reviewed = readContactMethods(reviewContactMethodsPatch(JSON.stringify([old]), draft, current));
  assert.equal(reviewed.length, 2);
  assert.equal(reviewed.find((item) => item.id === chosen.id)?.value, 'reviewed@example.test');
  assert.equal(reviewed.find((item) => item.id === chosen.id)?.label, chosen.label);
  assert.equal(reviewed.find((item) => item.id === newer.id)?.preferred, true);
  assert.equal(reviewed.find((item) => item.id === chosen.id)?.source, 'manual');
  const ambiguous = normalizeUserContactMethods([chosen, { ...method(old.value, 'email', false), label: 'Another source' }, newer]);
  const retained = readContactMethods(reviewContactMethodsPatch(JSON.stringify([old]), draft, ambiguous));
  assert.equal(retained.length, 4, 'Ambiguous originals remain separate for the explicit phone choice.');
  assert.equal(retained.find((item) => item.id === old.id)?.preferred, true);
  assert.equal(retained.filter((item) => item.preferred).length, 1);
  const second = { ...old, id: crypto.randomUUID(), preferred: false };
  const directCurrent = normalizeUserContactMethods([{ ...old, label: 'Existing direct method' }], JSON.stringify([old]));
  const directDraft = normalizeUserContactMethods([old, { ...second, label: 'Edited second method' }], JSON.stringify([old, second]));
  const separate = readContactMethods(reviewContactMethodsPatch(JSON.stringify([old, second]), directDraft, directCurrent));
  assert.equal(separate.length, 2);
  assert.equal(separate.find((item) => item.id === old.id)?.label, 'Existing direct method');
  assert.equal(separate.find((item) => item.id === second.id)?.label, 'Edited second method');
});
