import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = { origin: 'https://everclosecrm.com', userId: 'draft-test', workspaceId: 'draft-test',
  deviceId: '00000000-0000-4000-8000-000000000001', email: 'draft@example.test', name: 'Draft test',
  expiresAt: '2027-01-01T00:00:00Z', token: 'everclose_device_' + 'a'.repeat(43) };

test('an unfinished contact survives database reopen, stays private and is cleared atomically on creation', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(), form = drafts.contactForm();
    form.fields = { name: '', email: 'unfinished@', phone: '', notes: 'Private unsaved note', frequency: '' };
    await drafts.writeContactDraft(phone.db, key, form);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 0);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
    const reopened = await createMobileHarness(account, new Database(phone.sqlite.serialize()));
    try { assert.deepEqual(await reopened.contactDrafts.readContactDraft(reopened.db, key), form); }
    finally { reopened.close(); }
    await assert.rejects(phone.contacts.createContact(phone.db, { name: '' }, key));
    assert.deepEqual(await drafts.readContactDraft(phone.db, key), form);
    const created = await phone.contacts.createContact(phone.db, { name: 'Saved person', notes: form.fields.notes }, key);
    assert.equal(created.notes, form.fields.notes);
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 1);
  } finally { phone.close(); }
});

test('failed creation rolls back the person, outbox and draft deletion together', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(), form = drafts.contactForm();
    form.fields.name = 'Keep this draft';
    await drafts.writeContactDraft(phone.db, key, form);
    phone.faults.sqlContains = 'DELETE FROM app_metadata';
    await assert.rejects(phone.contacts.createContact(phone.db, { name: form.fields.name }, key));
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 0);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
    assert.deepEqual(await drafts.readContactDraft(phone.db, key), form);
  } finally { phone.close(); }
});

test('resumed edits retain the original base when cloud fields change and clear on successful save', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Original', notes: 'Original note' });
    const base = (await phone.contacts.getContactForEditing(phone.db, person.id))!;
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(person.id), form = drafts.contactForm(base);
    form.fields.notes = 'Phone draft';
    await drafts.writeContactDraft(phone.db, key, form);
    phone.sqlite.prepare('UPDATE contacts SET name = ?, notes = ? WHERE id = ?').run('Cloud name', 'Cloud note', person.id);
    const resumed = (await drafts.readContactDraft(phone.db, key))!;
    assert.equal(resumed.base!.notes, 'Original note');
    await phone.contacts.updateContact(phone.db, resumed.base!, { name: resumed.fields.name, notes: resumed.fields.notes }, key);
    const updated = (await phone.contacts.getContact(phone.db, person.id))!;
    assert.equal(updated.name, 'Cloud name');
    assert.equal(updated.notes, 'Phone draft');
    const intent = phone.sqlite.prepare("SELECT base_payload FROM sync_queue WHERE entity_type = 'contact' AND operation = 'update'").get();
    assert.equal(JSON.parse(intent.base_payload).notes, 'Original note');
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
  } finally { phone.close(); }
});

test('unchanged saves clear drafts without another sync intent, while removed people keep their drafts', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Original' });
    const base = (await phone.contacts.getContactForEditing(phone.db, person.id))!;
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(person.id), form = drafts.contactForm(base);
    await drafts.writeContactDraft(phone.db, key, form);
    await phone.contacts.updateContact(phone.db, base, { name: base.name }, key);
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 1);
    await drafts.writeContactDraft(phone.db, key, form);
    phone.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run('2026-10-05T00:00:00Z', person.id);
    await assert.rejects(phone.contacts.updateContact(phone.db, base, { name: 'Do not resurrect' }, key));
    assert.deepEqual(await drafts.readContactDraft(phone.db, key), form);
  } finally { phone.close(); }
});

test('serial draft writes cannot overwrite the newest edit or resurrect a completed form', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(), session = drafts.contactDraftSession(phone.db, key);
    const form = drafts.contactForm();
    form.fields.name = 'First'; const first = session.write(form);
    form.fields.name = 'Second'; const second = session.write(form);
    form.fields.name = 'Final'; const final = session.write(form);
    await session.finish(async () => {
      assert.equal((await drafts.readContactDraft(phone.db, key))!.fields.name, 'Final');
      await phone.contacts.createContact(phone.db, { name: 'Final' }, key);
    });
    await Promise.all([first, second, final]);
    await assert.rejects(session.write(form));
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
  } finally { phone.close(); }
});

test('resumed pre-merge drafts update the survivor locally and keep the original sync identity and base', async () => {
  const phone = await createMobileHarness(account);
  try {
    const retired = await phone.contacts.createContact(phone.db, { name: 'Original', notes: 'Original note' });
    const survivor = await phone.contacts.createContact(phone.db, { name: 'Survivor', email: 'keep@example.test' });
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(retired.id);
    const form = drafts.contactForm((await phone.contacts.getContactForEditing(phone.db, retired.id))!);
    form.fields.notes = 'Resumed note'; form.fields.phone = '+351123456789';
    await drafts.writeContactDraft(phone.db, key, form);
    phone.sqlite.prepare('INSERT INTO contact_aliases (id, canonical_id) VALUES (?, ?)').run(retired.id, survivor.id);
    phone.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run('2026-10-05', retired.id);
    await phone.contacts.updateContact(phone.db, form.base!, { name: form.fields.name, email: form.fields.email,
      phone: form.fields.phone, notes: form.fields.notes, contactFrequency: Number(form.fields.frequency) }, key);
    const current = (await phone.contacts.getContact(phone.db, retired.id))!;
    assert.equal(current.id, survivor.id); assert.equal(current.name, 'Survivor');
    assert.equal(current.email, 'keep@example.test'); assert.equal(current.notes, 'Resumed note');
    assert.ok(JSON.parse(current.contact_methods).some((method) => method.value === '+351123456789'));
    const intent = phone.sqlite.prepare("SELECT entity_id, base_payload FROM sync_queue WHERE operation = 'update'").get();
    assert.equal(intent.entity_id, retired.id); assert.equal(JSON.parse(intent.base_payload).notes, 'Original note');
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
  } finally { phone.close(); }
});

test('draft write failures prevent saving until retried, but explicit discard can remove the old form', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey(), form = drafts.contactForm();
    await drafts.writeContactDraft(phone.db, key, form);
    const session = drafts.contactDraftSession(phone.db, key);
    phone.faults.sqlContains = 'INSERT INTO app_metadata';
    await assert.rejects(session.write(form));
    let committed = false;
    await assert.rejects(session.finish(async () => { committed = true; }));
    assert.equal(committed, false);
    phone.faults.sqlContains = undefined;
    await session.finish(() => drafts.clearContactDraft(phone.db, key), true);
    assert.equal(await drafts.readContactDraft(phone.db, key), null);
  } finally { phone.close(); }
});

test('malformed and cross-person drafts are retained, account metadata cannot be cleared as a draft', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.contactDrafts, key = drafts.contactDraftKey();
    phone.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(key, '{broken', '2026-10-05');
    await assert.rejects(drafts.readContactDraft(phone.db, key));
    assert.equal(phone.sqlite.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key).value, '{broken');
    await assert.rejects(drafts.clearContactDraft(phone.db, 'account-scope'));
    await assert.rejects(drafts.writeContactDraft(phone.db, drafts.contactDraftKey('other'), drafts.contactForm()));
    await assert.rejects(phone.database.bindDatabaseAccount(phone.db, 'other-account'));
    assert.equal((await drafts.readContactDraft(phone.db, drafts.contactDraftKey('other'))), null);
  } finally { phone.close(); }
});
