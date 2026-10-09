import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = { origin: 'https://everclosecrm.com', userId: 'today-test', workspaceId: 'today-test',
  deviceId: '00000000-0000-4000-8000-000000000009', email: 'today@example.invalid', name: 'Today test',
  expiresAt: '2030-01-01T00:00:00Z', token: 'evd_' + 'a'.repeat(43) };
const instant = new Date('2026-10-05T12:00:00Z');
type Phone = Awaited<ReturnType<typeof createMobileHarness>>;
function person(phone: Phone, id: string, values: { birthday?: string; last?: string | null; cadence?: number } = {}) {
  phone.sqlite.prepare(`INSERT INTO contacts (id, name, birthday, last_contacted, contact_frequency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, `Person ${id}`, values.birthday ?? null, values.last ?? null, values.cadence ?? 14, instant.toISOString(), instant.toISOString());
}
function reminder(phone: Phone, id: string, contactId: string, at: string) {
  phone.sqlite.prepare(`INSERT INTO reminders (id, contact_id, title, remind_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, contactId, `Reminder ${id}`, at, instant.toISOString(), instant.toISOString());
}
function interaction(phone: Phone, id: string, contactId: string, at: string, summary = 'A confirmed conversation') {
  phone.sqlite.prepare(`INSERT INTO interactions (id, contact_id, type, date, occurred_at, summary, created_at, updated_at)
    VALUES (?, ?, 'message', ?, ?, ?, ?, ?)`).run(id, contactId, at.slice(0, 10), at, summary, at, at);
}

test('Today combines reasons once per person and reads only active, confirmed history without writing anything', async () => {
  const phone = await createMobileHarness(account);
  try {
    assert.deepEqual(await phone.today.getTodayQueue(phone.db, instant, 'Europe/Lisbon'), []);
    person(phone, 'one', { birthday: '1990-10-05', last: '2026-09-01' });
    reminder(phone, 'first', 'one', '2026-10-04T08:00:00Z');
    reminder(phone, 'second', 'one', '2026-10-05T09:00:00Z');
    interaction(phone, 'old', 'one', '2026-08-01T10:00:00Z', 'Old');
    interaction(phone, 'latest', 'one', '2026-09-01T10:00:00Z', 'Saved context');
    interaction(phone, 'deleted', 'one', '2026-10-05T10:00:00Z', 'Deleted');
    phone.sqlite.prepare('UPDATE interactions SET deleted_at = ? WHERE id = ?').run(instant.toISOString(), 'deleted');
    person(phone, 'removed'); reminder(phone, 'removed', 'removed', '2026-10-01T10:00:00Z');
    phone.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(instant.toISOString(), 'removed');
    person(phone, 'clear', { last: '2026-10-05' });
    reminder(phone, 'complete', 'clear', '2026-10-01T10:00:00Z');
    phone.sqlite.prepare('UPDATE reminders SET completed_at = ? WHERE id = ?').run(instant.toISOString(), 'complete');
    const before = phone.sqlite.serialize();
    const queue = await phone.today.getTodayQueue(phone.db, instant, 'Europe/Lisbon');
    assert.equal(queue.length, 1); assert.equal(queue[0].contact.id, 'one');
    assert.deepEqual(queue[0].reasons.map((reason) => reason.kind), ['reminder', 'birthday', 'check-in']);
    assert.equal(queue[0].reminder?.id, 'first'); assert.equal(queue[0].latestInteraction?.summary, 'Saved context');
    assert.deepEqual(phone.sqlite.serialize(), before);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 0);
  } finally { phone.close(); }
});

test('Today finds relevant people beyond the first 500 and duplicate reminders cannot fill its eight cards', async () => {
  const phone = await createMobileHarness(account);
  try {
    phone.sqlite.transaction(() => {
      for (let i = 0; i < 600; i++) person(phone, `early-${i}`, { last: '2026-10-05' });
      person(phone, 'zz-birthday', { birthday: '1990-10-05', last: '2026-10-05' });
      person(phone, 'zz-reminders', { last: '2026-10-05' });
      for (let i = 0; i < 510; i++) reminder(phone, `due-${i}`, 'zz-reminders', '2026-10-01T09:00:00Z');
      for (let i = 0; i < 10; i++) person(phone, `zz-check-in-${i}`, { last: '2026-08-01' });
    })();
    const queue = await phone.today.getTodayQueue(phone.db, instant, 'UTC');
    assert.equal(queue.length, 8); assert.equal(new Set(queue.map((item) => item.contact.id)).size, 8);
    assert.equal(queue[0].contact.id, 'zz-reminders'); assert.equal(queue[1].contact.id, 'zz-birthday');
    assert.equal(queue.filter((item) => item.contact.id === 'zz-reminders').length, 1);
    assert.equal(queue.filter((item) => item.reasons[0].kind === 'check-in').length, 6);
  } finally { phone.close(); }
});

test('Today respects local midnight, birthday preferences, year rollover and March 1 leap-birthday observance', async () => {
  const phone = await createMobileHarness(account);
  try {
    person(phone, 'leap', { birthday: '2000-02-29', last: '2027-02-28' });
    person(phone, 'tomorrow', { birthday: '1990-03-01', last: '2027-02-28' });
    phone.sqlite.prepare('INSERT INTO sync_remote_contacts VALUES (?, ?)').run('tomorrow', JSON.stringify({ data: { birthday_reminder_days: 0 } }));
    person(phone, 'invalid', { birthday: '1990-04-31', last: '2027-02-28' });
    let queue = await phone.today.getTodayQueue(phone.db, new Date('2027-02-28T12:00:00Z'), 'UTC');
    assert.deepEqual(queue.map((item) => item.contact.id), ['leap']);
    assert.equal(queue[0].reasons[0].title, 'Birthday tomorrow');
    queue = await phone.today.getTodayQueue(phone.db, new Date('2027-03-01T12:00:00Z'), 'UTC');
    assert.deepEqual(queue.map((item) => item.contact.id), ['leap', 'tomorrow']);
    assert.ok(queue.every((item) => item.reasons[0].title === 'Birthday today'));
    person(phone, 'year', { birthday: '1990-01-01', last: '2026-12-31' });
    assert.equal((await phone.today.getTodayQueue(phone.db, new Date('2026-12-31T12:00:00Z'), 'UTC')).find((item) => item.contact.id === 'year')?.reasons[0].title, 'Birthday tomorrow');
    phone.sqlite.prepare('DELETE FROM reminders').run();
    phone.sqlite.prepare('UPDATE contacts SET last_contacted = ?').run('2026-10-05');
    reminder(phone, 'late-local', 'year', '2026-10-05T22:59:00Z');
    reminder(phone, 'next-local-day', 'tomorrow', '2026-10-05T23:00:00Z');
    queue = await phone.today.getTodayQueue(phone.db, instant, 'Europe/Lisbon');
    assert.ok(queue.some((item) => item.reminder?.id === 'late-local'));
    assert.ok(!queue.some((item) => item.reminder?.id === 'next-local-day'));
    // The spring-forward day is 23 hours long. Date-only cadence remains civil.
    phone.sqlite.prepare('DELETE FROM reminders').run();
    phone.sqlite.prepare('UPDATE contacts SET last_contacted = ?, contact_frequency = 1').run('2026-03-29');
    assert.ok((await phone.today.getTodayQueue(phone.db, new Date('2026-03-29T23:30:00Z'), 'Europe/Lisbon')).every((item) => item.reasons.some((reason) => reason.kind === 'check-in')));
  } finally { phone.close(); }
});

test('a recent instant suppresses UTC-midnight check-ins and paging continues through excluded candidates', async () => {
  const phone = await createMobileHarness(account);
  try {
    phone.sqlite.transaction(() => {
      for (let i = 0; i < 40; i++) {
        person(phone, `recent-${i}`, { last: '2026-10-04', cadence: 1 });
        interaction(phone, `recent-${i}`, `recent-${i}`, '2026-10-04T23:30:00Z');
      }
      person(phone, 'true-check-in', { last: '2026-10-04', cadence: 1 });
    })();
    const queue = await phone.today.getTodayQueue(phone.db, new Date('2026-10-05T00:30:00Z'), 'Europe/Lisbon');
    assert.deepEqual(queue.map((item) => item.contact.id), ['true-check-in']);
    const negativeZone = await phone.today.getTodayQueue(phone.db, new Date('2026-10-05T01:00:00Z'), 'America/Los_Angeles');
    assert.deepEqual(negativeZone, []);
  } finally { phone.close(); }
});

test('completing and snoozing a Today reminder preserve independent reasons and do not manufacture a conversation', async () => {
  const phone = await createMobileHarness(account);
  try {
    const contact = await phone.contacts.createContact(phone.db, { name: 'Birthday person', notes: 'Private memory' });
    const now = new Date();
    phone.sqlite.prepare('UPDATE contacts SET birthday = ? WHERE id = ?').run(`1990-${now.toISOString().slice(5, 10)}`, contact.id);
    const first = await phone.reminders.createReminder(phone.db, { contactId: contact.id, title: 'First', remindAt: new Date(Date.now() + 86_400_000) }, null);
    phone.sqlite.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run('2000-01-01T09:00:00Z', first.id);
    let queue = await phone.today.getTodayQueue(phone.db, now, 'UTC');
    assert.equal(queue[0].reasons.length, 3);
    await phone.reminders.snoozeReminder(phone.db, queue[0].reminder!, new Date(Date.now() + 3 * 86_400_000));
    queue = await phone.today.getTodayQueue(phone.db, now, 'UTC');
    assert.deepEqual(queue[0].reasons.map((reason) => reason.kind), ['birthday', 'check-in']);
    await phone.reminders.completeReminder(phone.db, first.id);
    assert.equal(phone.sqlite.prepare('SELECT COUNT(*) n FROM interactions').get().n, 0);
    await phone.contacts.logInteraction(phone.db, contact.id, 'message');
    const restarted = await createMobileHarness(account, new Database(phone.sqlite.serialize()));
    try {
      queue = await restarted.today.getTodayQueue(restarted.db, new Date(), 'UTC');
      assert.deepEqual(queue[0].reasons.map((reason) => reason.kind), ['birthday']);
      assert.equal(queue[0].latestInteraction?.type, 'message');
      assert.equal(queue[0].contact.notes, 'Private memory');
      assert.equal(restarted.sqlite.prepare("SELECT COUNT(*) n FROM sync_queue WHERE entity_type = 'interaction'").get().n, 1);
    } finally { restarted.close(); }
  } finally { phone.close(); }
});
