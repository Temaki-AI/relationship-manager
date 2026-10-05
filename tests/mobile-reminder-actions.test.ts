import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = { origin: 'https://everclosecrm.com', userId: 'snooze-test', workspaceId: 'snooze-test',
  deviceId: '00000000-0000-4000-8000-000000000007', email: 'snooze@example.invalid', name: 'Snooze test',
  expiresAt: '2030-01-01T00:00:00Z', token: 'evd_' + 'a'.repeat(43) };
const future = (days: number) => new Date(Date.now() + days * 86_400_000);

test('snooze survives restart with its original sync base, clears only the old scheduling receipt and creates no history', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person', notes: 'Private memory' });
    const reminder = await phone.reminders.createReminder(phone.db, { contactId: person.id, title: 'Catch up', notes: 'Private context', remindAt: future(1) }, 'old-alert');
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const next = future(3);
    const moved = await phone.reminders.snoozeReminder(phone.db, reminder, next);
    assert.equal(moved.changed, true); assert.equal(moved.previousNotificationId, 'old-alert');
    const reopened = await createMobileHarness(account, new Database(phone.sqlite.serialize()));
    try {
      const [saved] = await reopened.reminders.listOpenReminders(reopened.db);
      assert.equal(saved.remind_at, next.toISOString()); assert.equal(saved.completed_at, null);
      assert.equal(saved.title, reminder.title); assert.equal(saved.notes, reminder.notes); assert.equal(saved.notification_id, null);
      const intent = reopened.sqlite.prepare("SELECT * FROM sync_queue WHERE entity_type = 'reminder'").get();
      assert.deepEqual(JSON.parse(intent.payload), { remind_at: next.toISOString() });
      assert.deepEqual(JSON.parse(intent.base_payload), { remind_at: reminder.remind_at });
      assert.equal(reopened.sqlite.prepare('SELECT COUNT(*) n FROM interactions').get().n, 0);
      assert.equal((await reopened.contacts.getContact(reopened.db, person.id))?.notes, 'Private memory');
      assert.equal(await reopened.reminders.saveReminderNotification(reopened.db, reminder, 'late-old-alert'), false);
      assert.equal(await reopened.reminders.saveReminderNotification(reopened.db, saved, 'new-alert'), true);
    } finally { reopened.close(); }
  } finally { phone.close(); }
});

test('an outbox failure rolls back snooze and keeps the old reminder and iOS receipt', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    const reminder = await phone.reminders.createReminder(phone.db, { contactId: person.id, title: 'Catch up', remindAt: future(1) }, 'old-alert');
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    phone.faults.sqlContains = 'INSERT INTO sync_queue';
    await assert.rejects(phone.reminders.snoozeReminder(phone.db, reminder, future(3)), /write failure/);
    assert.deepEqual((await phone.reminders.listOpenReminders(phone.db))[0], reminder);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 0);
  } finally { phone.close(); }
});

test('stale times, completed/deleted people and invalid times cannot create a snooze intent', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    const reminder = await phone.reminders.createReminder(phone.db, { contactId: person.id, title: 'Catch up', remindAt: future(1) }, 'old-alert');
    for (const date of [new Date(NaN), new Date(0)]) await assert.rejects(phone.reminders.snoozeReminder(phone.db, reminder, date), /future/);
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const moved = await phone.reminders.snoozeReminder(phone.db, reminder, future(3));
    await assert.rejects(phone.reminders.snoozeReminder(phone.db, reminder, future(7)), /time changed/);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 1);
    await phone.reminders.completeReminder(phone.db, moved.reminder.id);
    const count = phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n;
    await assert.rejects(phone.reminders.snoozeReminder(phone.db, moved.reminder, future(7)), /no longer open/);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, count);
    const other = await phone.reminders.createReminder(phone.db, { contactId: person.id, title: 'Another', remindAt: future(1) }, null);
    phone.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), person.id);
    await assert.rejects(phone.reminders.snoozeReminder(phone.db, other, future(3)), /no longer open/);
  } finally { phone.close(); }
});

test('the same instant is a no-op and moving a held reminder retains its conflict status', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Person' });
    const reminder = await phone.reminders.createReminder(phone.db, { contactId: person.id, title: 'Catch up', remindAt: future(1) }, 'old-alert');
    phone.sqlite.prepare('DELETE FROM sync_queue').run();
    const same = await phone.reminders.snoozeReminder(phone.db, reminder, new Date(reminder.remind_at));
    assert.equal(same.changed, false); assert.equal(same.reminder.notification_id, 'old-alert');
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 0);
    const remote = { revision: 7, data: { remind_at: reminder.remind_at } };
    phone.sqlite.prepare('INSERT INTO sync_remote_entities (entity_type, id, record_json) VALUES (?, ?, ?)').run('reminder', reminder.id, JSON.stringify(remote));
    await phone.queue.enqueueSyncIntent(phone.db, 'reminder', reminder.id, 'update', { notes: 'Held note' }, new Date().toISOString());
    phone.sqlite.prepare("UPDATE sync_queue SET status = 'conflict' WHERE entity_id = ?").run(reminder.id);
    await phone.reminders.snoozeReminder(phone.db, reminder, future(3));
    assert.equal(phone.sqlite.prepare('SELECT sync_state FROM reminders WHERE id = ?').get(reminder.id).sync_state, 'conflict');
    assert.equal(phone.sqlite.prepare("SELECT base_revision FROM sync_queue WHERE status = 'pending'").get().base_revision, 7);
  } finally { phone.close(); }
});
