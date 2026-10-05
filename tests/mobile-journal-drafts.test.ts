import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = { origin: 'https://everclosecrm.com', userId: 'journal-test', workspaceId: 'journal-test',
  deviceId: '00000000-0000-4000-8000-000000000001', email: 'journal@example.test', name: 'Journal test',
  expiresAt: '2027-01-01T00:00:00Z', token: 'everclose_device_' + 'a'.repeat(43) };

test('unfinished plan, family, relationship and reminder forms survive reopen without creating records or outbox writes', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const drafts = phone.journalDrafts;
    const forms = ['plan', 'family', 'relationship'].map((kind) => drafts.contextForm(kind as 'plan' | 'family' | 'relationship', person.id));
    forms[0].fields.planned_date = '2030-01-'; forms[0].fields.notes = 'Unfinished private plan';
    forms[1].fields.birthday = '2030-'; forms[1].fields.name = '';
    forms[2].fields.relationship_label = 'Unfinished label';
    const reminder = drafts.reminderForm(person.id, new Date('2030-01-01T12:00:00Z'));
    reminder.notes = 'Unfinished private reminder';
    for (const form of [...forms, reminder]) await drafts.journalDraftSession(phone.db, drafts.journalDraftKey(form.kind, person.id)).write(form);
    const reopened = await createMobileHarness(account, new Database(phone.sqlite.serialize()));
    try {
      for (const form of [...forms, reminder]) assert.deepEqual(await reopened.journalDrafts.readJournalDraft(reopened.db, drafts.journalDraftKey(form.kind, person.id)), form);
    } finally { reopened.close(); }
    for (const table of ['plans', 'contact_children', 'contact_relationships', 'reminders', 'sync_queue']) {
      assert.equal(phone.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { phone.close(); }
});

test('successful context creation clears drafts atomically; a failed clear rolls back the item and intent', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const drafts = phone.journalDrafts, key = drafts.journalDraftKey('plan', person.id), form = drafts.contextForm('plan', person.id);
    form.fields.summary = 'Keep this draft';
    const writer = drafts.journalDraftSession(phone.db, key); await writer.write(form);
    phone.faults.sqlContains = 'DELETE FROM app_metadata';
    await assert.rejects(writer.finish(() => phone.context.createContext(phone.db, 'plan', person.id, form.fields, key)));
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
    assert.deepEqual(await drafts.readJournalDraft(phone.db, key), form);
    phone.faults.sqlContains = undefined;
    await writer.finish(() => phone.context.createContext(phone.db, 'plan', person.id, form.fields, key));
    assert.equal(await drafts.readJournalDraft(phone.db, key), null);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 1);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 1);
    await assert.rejects(writer.write(form));
  } finally { phone.close(); }
});

test('resumed context edits preserve exact original fields/revision and unchanged saves do not enqueue another change', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    const id = await phone.context.createContext(phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2030-01-02', summary: 'Original', notes: 'Original note' });
    phone.sqlite.prepare('UPDATE plans SET notes = ? WHERE id = ?').run('  Original note  ', id);
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const drafts = phone.journalDrafts, key = drafts.journalDraftKey('plan', '', id);
    const base = (await phone.context.contextForEditing(phone.db, 'plan', id))!;
    const form = drafts.contextForm('plan', person.id, base); form.fields.notes = 'Phone draft';
    await drafts.journalDraftSession(phone.db, key).write(form);
    phone.sqlite.prepare('UPDATE plans SET summary = ?, notes = ? WHERE id = ?').run('Cloud summary', 'Cloud note', id);
    const resumed = (await drafts.readJournalDraft(phone.db, key))!;
    assert.equal(resumed.kind, 'plan');
    if (resumed.kind === 'reminder') throw new Error('Wrong draft kind');
    assert.equal(resumed.base!.notes, '  Original note  ');
    await phone.context.updateContext(phone.db, 'plan', resumed.base!, resumed.fields, key);
    assert.equal((await phone.context.contextForEditing(phone.db, 'plan', id))!.summary, 'Cloud summary');
    const intent = phone.sqlite.prepare("SELECT base_payload FROM sync_queue WHERE entity_type = 'plan'").get();
    assert.equal(JSON.parse(intent.base_payload).notes, '  Original note  ');
    assert.equal(await drafts.readJournalDraft(phone.db, key), null);
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const current = (await phone.context.contextForEditing(phone.db, 'plan', id))!;
    const unchanged = drafts.contextForm('plan', person.id, current);
    await drafts.journalDraftSession(phone.db, key).write(unchanged);
    await phone.context.updateContext(phone.db, 'plan', unchanged.base!, unchanged.fields, key);
    assert.equal(await drafts.readJournalDraft(phone.db, key), null);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
  } finally { phone.close(); }
});

test('deleted context retains the original form rather than recreating its record', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    const id = await phone.context.createContext(phone.db, 'family', person.id, { name: 'Child' });
    const drafts = phone.journalDrafts, key = drafts.journalDraftKey('family', '', id);
    const form = drafts.contextForm('family', person.id, (await phone.context.contextForEditing(phone.db, 'family', id))!);
    form.fields.name = 'Phone draft'; await drafts.journalDraftSession(phone.db, key).write(form);
    phone.sqlite.prepare('UPDATE contact_children SET deleted_at = ? WHERE id = ?').run('2026-10-05', id);
    await assert.rejects(phone.context.updateContext(phone.db, 'family', form.base!, form.fields, key));
    assert.deepEqual(await drafts.readJournalDraft(phone.db, key), form);
  } finally { phone.close(); }
});

test('a resumed reminder keeps its absolute date; an expired date remains a draft until the user chooses another time', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const drafts = phone.journalDrafts, key = drafts.journalDraftKey('reminder', person.id);
    const form = drafts.reminderForm(person.id, new Date('2020-01-01T12:00:00Z')); form.title = 'Private reminder';
    const writer = drafts.journalDraftSession(phone.db, key); await writer.write(form);
    const resumed = (await drafts.readJournalDraft(phone.db, key))!;
    assert.equal(resumed.kind, 'reminder');
    if (resumed.kind !== 'reminder') throw new Error('Wrong draft kind');
    assert.equal(resumed.remindAt, form.remindAt);
    await assert.rejects(phone.reminders.createReminder(phone.db, { contactId: person.id, title: resumed.title, remindAt: resumed.remindAt }, null, key), /future/);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 0);
    assert.deepEqual(await drafts.readJournalDraft(phone.db, key), form);
    form.remindAt = '2030-01-02T09:00:00.000Z'; await writer.write(form);
    phone.faults.sqlContains = 'DELETE FROM app_metadata';
    await assert.rejects(writer.finish(() => phone.reminders.createReminder(phone.db, { contactId: person.id, title: form.title, remindAt: form.remindAt }, null, key)));
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 0);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
    phone.faults.sqlContains = undefined;
    const reminder = await writer.finish(() => phone.reminders.createReminder(phone.db, { contactId: person.id, title: form.title, remindAt: form.remindAt }, null, key));
    assert.equal(await drafts.readJournalDraft(phone.db, key), null);
    assert.equal(await phone.reminders.saveReminderNotification(phone.db, reminder, 'notification-id'), true);
    phone.sqlite.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run('2030-02-01T09:00:00.000Z', reminder.id);
    assert.equal(await phone.reminders.saveReminderNotification(phone.db, reminder, 'stale-notification-id'), false);
  } finally { phone.close(); }
});

test('draft identity and corruption fences preserve account metadata and serial writes close before discard', async () => {
  const phone = await createMobileHarness(account);
  try {
    const drafts = phone.journalDrafts, key = drafts.journalDraftKey('reminder'), writer = drafts.journalDraftSession(phone.db, key);
    const form = drafts.reminderForm('', new Date('2030-01-01T12:00:00Z'));
    form.title = 'First'; const first = writer.write(form);
    form.title = 'Final'; const second = writer.write(form);
    await writer.finish(async () => { assert.equal((await drafts.readJournalDraft(phone.db, key) as typeof form).title, 'Final'); await drafts.clearJournalDraft(phone.db, key); }, true);
    await Promise.all([first, second]); await assert.rejects(writer.write(form));
    assert.equal(await drafts.readJournalDraft(phone.db, key), null);
    await assert.rejects(drafts.clearJournalDraft(phone.db, 'account-scope'));
    phone.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(key, '{broken', '2026-10-05');
    await assert.rejects(drafts.readJournalDraft(phone.db, key));
    assert.equal(phone.sqlite.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key).value, '{broken');
    const other = drafts.journalDraftSession(phone.db, drafts.journalDraftKey('family'));
    await assert.rejects(other.write(form));
  } finally { phone.close(); }
});
