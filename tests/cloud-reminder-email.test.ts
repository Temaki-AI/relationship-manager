import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

async function seed(harness: Awaited<ReturnType<typeof createCloudHarness>>) {
  const { db } = harness;
  await db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('user-1', 'Owner', 'owner@example.com', 1, 1, 1),
      ('user-2', 'Other', 'other@example.com', 1, 1, 1)`).run();
  await db.prepare(`INSERT INTO workspace_members (workspace_id, user_id)
    VALUES ('test', 'user-1'), ('other', 'user-2')`).run();
  await db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Contact'), ('other', 'Other contact')").run();
  const contact = await db.prepare("SELECT id FROM contacts WHERE workspace_id = 'test'").first<{ id: number }>();
  const other = await db.prepare("SELECT id FROM contacts WHERE workspace_id = 'other'").first<{ id: number }>();
  return { contactId: contact!.id, otherContactId: other!.id };
}

function settingsRequest(method: 'GET' | 'PATCH', body?: unknown) {
  return new Request('https://test.invalid/api/reminders/email-preferences', {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
}

test('email preferences require verified mail and a configured sender, and are account-scoped', async () => {
  const harness = await createCloudHarness();
  try {
    await seed(harness);
    const input = { enabled: true, timeZone: 'Europe/Lisbon', quietStartHour: 22, quietEndHour: 8 };
    assert.equal((await harness.emailSettings(settingsRequest('PATCH', input))).status, 503);
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async () => ({ messageId: 'test' }) };
    assert.equal((await harness.emailSettings(settingsRequest('PATCH', { ...input, timeZone: 'Not/AZone' }))).status, 400);
    assert.equal((await harness.emailSettings(settingsRequest('PATCH', input))).status, 200);
    const own = await (await harness.emailSettings(settingsRequest('GET'))).json() as { enabled: boolean; timeZone: string };
    assert.equal(own.enabled, true);
    assert.equal(own.timeZone, 'Europe/Lisbon');
    const other = await (await harness.emailSettings(settingsRequest('GET'), 'other', 'user-2')).json() as { enabled: boolean };
    assert.equal(other.enabled, false);
    await harness.db.prepare("UPDATE user SET email_verified = 0 WHERE id = 'user-1'").run();
    assert.equal((await harness.emailSettings(settingsRequest('PATCH', input))).status, 503);
    assert.equal((await harness.emailSettings(settingsRequest('PATCH', { ...input, enabled: false }))).status, 200);
  } finally { await harness.close(); }
});

test('quiet-hour expiry follows the local clock across daylight-saving changes', async () => {
  const harness = await createCloudHarness();
  try {
    const beforeSummerShift = new Date('2026-03-29T00:30:00.000Z');
    assert.equal(harness.isQuietHour(beforeSummerShift, 'Europe/Lisbon', 22, 8), true);
    assert.equal(harness.nextAllowedEmailTime(beforeSummerShift, 'Europe/Lisbon', 22, 8), '2026-03-29T07:00:00.000Z');
    const beforeWinterShift = new Date('2026-10-25T00:30:00.000Z');
    assert.equal(harness.isQuietHour(beforeWinterShift, 'Europe/Lisbon', 22, 8), true);
    assert.equal(harness.nextAllowedEmailTime(beforeWinterShift, 'Europe/Lisbon', 22, 8), '2026-10-25T08:00:00.000Z');
  } finally { await harness.close(); }
});

test('scheduled delivery sends only due opt-in events once without private reminder content', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId, otherContactId } = await seed(harness);
    const now = new Date('2026-10-02T12:00:00.000Z');
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'user-1', 1, '2026-10-02T10:00:00.000Z', 'UTC', 22, 8)`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, notes, remind_at)
      VALUES ('test', ?, 'Private title', 'Private notes', '2026-10-02T11:00:00.000Z'),
        ('test', ?, 'Old before opt-in', NULL, '2026-10-02T09:00:00.000Z'),
        ('test', ?, 'Not due', NULL, '2026-10-03T09:00:00.000Z'),
        ('other', ?, 'Other account', NULL, '2026-10-02T11:00:00.000Z')`)
      .bind(contactId, contactId, contactId, otherContactId).run();
    const messages: Array<{ to: string; subject: string; text: string }> = [];
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async (message: { to: string; subject: string; text: string }) => {
      messages.push(message);
      return { messageId: 'fake-1' };
    } };
    assert.equal((await harness.deliverEmails(now)).sent, 1);
    assert.equal((await harness.deliverEmails(now)).sent, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'owner@example.com');
    assert.doesNotMatch(JSON.stringify(messages[0]), /Private title|Private notes|Contact|Other account/);
    const deliveries = await harness.db.prepare('SELECT status, provider_message_id FROM reminder_email_deliveries').all();
    assert.equal(deliveries.results.length, 1);
    assert.equal(deliveries.results[0].status, 'sent');
  } finally { await harness.close(); }
});

test('quiet hours defer delivery and failed attempts retry without creating duplicate events', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'user-1', 1, '2026-10-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'Due', '2026-10-02T22:30:00.000Z')`).bind(contactId).run();
    let calls = 0;
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async () => {
      calls++;
      if (calls === 1) throw new Error('Simulated provider outage');
      return { messageId: 'fake-2' };
    } };
    assert.equal((await harness.deliverEmails(new Date('2026-10-02T23:00:00.000Z'))).quiet, 1);
    assert.equal(calls, 0);
    assert.equal((await harness.deliverEmails(new Date('2026-10-03T08:00:00.000Z'))).failed, 1);
    assert.equal((await harness.deliverEmails(new Date('2026-10-03T08:14:59.000Z'))).sent, 0);
    assert.equal((await harness.deliverEmails(new Date('2026-10-03T08:15:00.000Z'))).sent, 1);
    assert.equal(calls, 2);
    const rows = await harness.db.prepare('SELECT attempts, status FROM reminder_email_deliveries').all();
    assert.deepEqual(rows.results, [{ attempts: 2, status: 'sent' }]);
  } finally { await harness.close(); }
});

test('multiple due reminders are bundled into one generic email per account', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId, otherContactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'user-1', 1, '2026-10-02T10:00:00.000Z', 'UTC', 22, 8),
        ('other', 'user-2', 1, '2026-10-02T10:00:00.000Z', 'UTC', 22, 8)`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'Private one', '2026-10-02T11:00:00.000Z'),
        ('test', ?, 'Private two', '2026-10-02T11:00:00.000Z'),
        ('test', ?, 'Private three', '2026-10-02T11:00:00.000Z'),
        ('other', ?, 'Other account', '2026-10-02T11:00:00.000Z')`)
      .bind(contactId, contactId, contactId, otherContactId).run();
    const messages: Array<{ to: string; text: string }> = [];
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async (message: { to: string; text: string }) => {
      messages.push(message);
      return { messageId: `fake-${messages.length}` };
    } };
    const result = await harness.deliverEmails(new Date('2026-10-02T12:00:00.000Z'));
    assert.equal(result.sent, 2);
    assert.equal(result.eventsSent, 4);
    assert.equal(messages.length, 2);
    assert.match(messages.find((message) => message.to === 'owner@example.com')?.text || '', /3 reminders due/);
    assert.doesNotMatch(JSON.stringify(messages), /Private one|Private two|Private three|Other account/);
    assert.equal((await harness.deliverEmails(new Date('2026-10-02T12:15:00.000Z'))).sent, 0);
  } finally { await harness.close(); }
});

test('quiet-hour backlog is postponed so another account can receive its due email', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId, otherContactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'user-1', 1, '2026-10-01T00:00:00.000Z', 'UTC', 22, 8),
        ('other', 'user-2', 1, '2026-10-01T00:00:00.000Z', 'Pacific/Honolulu', 22, 8)`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      SELECT 'test', ?, value, '2026-10-02T22:30:00.000Z' FROM json_each(?)`)
      .bind(contactId, JSON.stringify(Array.from({ length: 100 }, (_, index) => `Private ${index}`))).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('other', ?, 'Ready', '2026-10-02T22:30:00.000Z')`).bind(otherContactId).run();
    const sentTo: string[] = [];
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async (message: { to: string }) => {
      sentTo.push(message.to);
      return { messageId: 'fake-ready' };
    } };
    const result = await harness.deliverEmails(new Date('2026-10-02T23:00:00.000Z'));
    assert.equal(result.sent, 1);
    assert.deepEqual(sentTo, ['other@example.com']);
    assert.equal(result.quiet, 100);
    const deferred = await harness.db.prepare(`SELECT COUNT(*) AS count FROM reminder_email_deliveries
      WHERE workspace_id = 'test' AND next_attempt_at = '2026-10-03T08:00:00.000Z'`)
      .first<{ count: number }>();
    assert.equal(deferred?.count, 100);
    const next = await harness.deliverEmails(new Date('2026-10-03T08:00:00.000Z'));
    assert.equal(next.sent, 1);
    assert.equal(next.eventsSent, 20);
  } finally { await harness.close(); }
});

test('a grouped provider failure preserves each event’s own retry limit', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at) VALUES ('test', 'user-1', 1, '2026-10-01T00:00:00.000Z')`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'One', '2026-10-02T11:00:00.000Z'),
        ('test', ?, 'Two', '2026-10-02T11:00:00.000Z')`).bind(contactId, contactId).run();
    await harness.db.prepare(`INSERT INTO reminder_email_deliveries
      (workspace_id, user_id, reminder_id, remind_at, next_attempt_at, attempts)
      SELECT workspace_id, 'user-1', id, remind_at, '2026-10-02T12:00:00.000Z',
        CASE WHEN title = 'One' THEN 4 ELSE 1 END FROM reminders WHERE workspace_id = 'test'`).run();
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async () => { throw new Error('Simulated provider outage'); } };
    assert.equal((await harness.deliverEmails(new Date('2026-10-02T12:00:00.000Z'))).failed, 1);
    const rows = await harness.db.prepare(`SELECT r.title, d.status, d.attempts, d.next_attempt_at FROM reminder_email_deliveries d
      JOIN reminders r ON r.id = d.reminder_id ORDER BY r.title`).all();
    assert.deepEqual(rows.results, [
      { title: 'One', status: 'failed', attempts: 5, next_attempt_at: '2026-10-02T16:00:00.000Z' },
      { title: 'Two', status: 'pending', attempts: 2, next_attempt_at: '2026-10-02T12:30:00.000Z' },
    ]);
  } finally { await harness.close(); }
});

test('overlapping scheduled runs claim the same due event only once', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at) VALUES ('test', 'user-1', 1, '2026-10-01T00:00:00.000Z')`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'One', '2026-10-02T11:00:00.000Z')`).bind(contactId).run();
    let sends = 0;
    harness.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    harness.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'fake-once' }; } };
    const now = new Date('2026-10-02T12:00:00.000Z');
    const results = await Promise.all([harness.deliverEmails(now), harness.deliverEmails(now)]);
    assert.equal(results.reduce((count, result) => count + result.sent, 0), 1);
    assert.equal(sends, 1);
  } finally { await harness.close(); }
});

test('delivery rows follow reminder deletion and cross-workspace associations are rejected', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId, otherContactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at) VALUES ('test', 'user-1', 1, '2026-10-01T00:00:00.000Z')`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'Due', '2026-10-02T11:00:00.000Z'),
        ('other', ?, 'Other', '2026-10-02T11:00:00.000Z')`).bind(contactId, otherContactId).run();
    const own = await harness.db.prepare("SELECT id FROM reminders WHERE workspace_id = 'test'").first<{ id: number }>();
    const other = await harness.db.prepare("SELECT id FROM reminders WHERE workspace_id = 'other'").first<{ id: number }>();
    await assert.rejects(harness.db.prepare(`INSERT INTO reminder_email_deliveries
      (workspace_id, user_id, reminder_id, remind_at, next_attempt_at) VALUES
      ('test', 'user-1', ?, '2026-10-02T11:00:00.000Z', '2026-10-02T12:00:00.000Z')`).bind(other!.id).run());
    await harness.db.prepare(`INSERT INTO reminder_email_deliveries
      (workspace_id, user_id, reminder_id, remind_at, next_attempt_at) VALUES
      ('test', 'user-1', ?, '2026-10-02T11:00:00.000Z', '2026-10-02T12:00:00.000Z')`).bind(own!.id).run();
    await harness.db.prepare('DELETE FROM reminders WHERE id = ?').bind(own!.id).run();
    assert.equal((await harness.db.prepare('SELECT id FROM reminder_email_deliveries').all()).results.length, 0);
  } finally { await harness.close(); }
});

test('restore clears delivery history and resets the opt-in baseline; erasure removes settings', async () => {
  const harness = await createCloudHarness();
  try {
    const { contactId } = await seed(harness);
    await harness.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at) VALUES ('test', 'user-1', 1, '2026-01-01T00:00:00.000Z')`).run();
    await harness.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'Due', '2027-10-02T11:00:00.000Z')`).bind(contactId).run();
    const reminder = await harness.db.prepare("SELECT id FROM reminders WHERE workspace_id = 'test'").first<{ id: number }>();
    const backup = await harness.call('settings/backups', { method: 'POST' });
    assert.equal(backup.status, 201);
    await harness.db.prepare(`INSERT INTO reminder_email_deliveries
      (workspace_id, user_id, reminder_id, remind_at, next_attempt_at, status)
      VALUES ('test', 'user-1', ?, '2027-10-02T11:00:00.000Z', '2027-10-02T11:00:00.000Z', 'sent')`)
      .bind(reminder!.id).run();
    const restore = await harness.call('settings/restore', {
      method: 'POST', body: { confirmation: 'RESTORE', filename: backup.body.backup.filename },
    });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal((await harness.db.prepare("SELECT COUNT(*) AS count FROM reminder_email_deliveries WHERE workspace_id = 'test'").first<{ count: number }>())!.count, 0);
    const preference = await harness.db.prepare("SELECT enabled, enabled_at FROM reminder_email_preferences WHERE workspace_id = 'test'")
      .first<{ enabled: number; enabled_at: string | null }>();
    assert.equal(preference?.enabled, 0);
    assert.equal(preference?.enabled_at, null);
    const erased = await harness.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal((await harness.db.prepare("SELECT COUNT(*) AS count FROM reminder_email_preferences WHERE workspace_id = 'test'").first<{ count: number }>())!.count, 0);
  } finally { await harness.close(); }
});
