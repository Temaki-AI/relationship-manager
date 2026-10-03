import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

async function seed(h: Awaited<ReturnType<typeof createCloudHarness>>) {
  await h.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('birthday-user-1', 'One', 'one@example.com', 1, 1, 1),
      ('birthday-user-2', 'Two', 'two@example.com', 1, 1, 1)`).run();
  await h.db.prepare(`INSERT INTO workspace_members (workspace_id, user_id)
    VALUES ('test', 'birthday-user-1'), ('other', 'birthday-user-2')`).run();
  h.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
}

test('annual birthday emails observe leap birthdays and account-local dates once', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'Pacific/Kiritimati', 22, 8),
        ('other', 'birthday-user-2', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Private leap', '2000-02-29', 0),
        ('test', 'Private upcoming', '2000-03-02', 1),
        ('other', 'Other leap', '2000-02-29', 0)`).run();
    const messages: Array<{ to: string; subject: string; text: string }> = [];
    h.emailEnv.EMAIL = { send: async (message: { to: string; subject: string; text: string }) => {
      messages.push(message);
      return { messageId: `birthday-${messages.length}` };
    } };
    const first = await h.deliverBirthdayEmails(new Date('2026-02-28T23:30:00.000Z'));
    assert.equal(first.sent, 1);
    assert.equal(first.eventsSent, 2);
    assert.equal(messages[0].to, 'one@example.com');
    assert.match(messages[0].text, /2 birthday alerts/);
    assert.doesNotMatch(JSON.stringify(messages), /Private leap|Private upcoming|Other leap/);
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-03-01T00:00:00.000Z'))).sent, 0);
    const second = await h.deliverBirthdayEmails(new Date('2026-03-01T08:00:00.000Z'));
    assert.equal(second.sent, 1);
    assert.equal(messages[1].to, 'two@example.com');
    const occurrences = await h.db.prepare('SELECT occurrence FROM birthday_email_deliveries ORDER BY workspace_id, contact_id').all();
    assert.deepEqual(occurrences.results.map((row) => row.occurrence), ['2026-03-01', '2026-03-01', '2026-03-02']);
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-03-01T08:15:00.000Z'))).sent, 0);
    const nextYear = await h.deliverBirthdayEmails(new Date('2027-02-28T23:30:00.000Z'));
    assert.equal(nextYear.sent, 1);
    assert.equal(nextYear.eventsSent, 2);
  } finally { await h.close(); }
});

test('child birthdays share one private annual email bundle with their parent and remain tenant-scoped', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'Pacific/Kiritimati', 22, 8),
        ('other', 'birthday-user-2', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    const parent = await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Private parent', '2000-03-01', 7) RETURNING id`).first<{ id: number }>();
    const foreign = await h.db.prepare(`INSERT INTO contacts (workspace_id, name)
      VALUES ('other', 'Other parent') RETURNING id`).first<{ id: number }>();
    const child = await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('test', ?, 'Private child', '2000-02-29') RETURNING id`).bind(parent!.id).first<{ id: number }>();
    await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('test', ?, 'Private sibling', '2000-02-29')`).bind(parent!.id).run();
    const foreignChild = await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('other', ?, 'Other child', '2000-12-25') RETURNING id`).bind(foreign!.id).first<{ id: number }>();
    await assert.rejects(h.db.prepare(`INSERT INTO birthday_email_deliveries
      (workspace_id, user_id, contact_id, child_id, occurrence, next_attempt_at)
      VALUES ('test', 'birthday-user-1', ?, ?, '2026-03-01', '2026-02-22T12:00:00Z')`)
      .bind(parent!.id, foreignChild!.id).run());
    const messages: Array<{ to: string; text: string }> = [];
    h.emailEnv.EMAIL = { send: async (message: { to: string; text: string }) => {
      messages.push(message);
      return { messageId: `child-${messages.length}` };
    } };
    const now = new Date('2026-02-22T19:00:00.000Z');
    const first = await h.deliverBirthdayEmails(now);
    assert.equal(first.sent, 1);
    assert.equal(first.eventsSent, 3, 'parent and two children can share an occurrence');
    assert.equal(messages[0].to, 'one@example.com');
    assert.doesNotMatch(JSON.stringify(messages), /Private parent|Private child|Private sibling|Other child/);
    const rows = await h.db.prepare(`SELECT contact_id, child_id, occurrence, status FROM birthday_email_deliveries
      WHERE workspace_id = 'test' ORDER BY child_id`).all<{ contact_id: number; child_id: number | null; occurrence: string; status: string }>();
    assert.equal(rows.results.length, 3);
    assert.equal(rows.results[0].child_id, null);
    assert.ok(rows.results.some((row) => row.child_id === child!.id));
    assert.ok(rows.results.every((row) => row.occurrence === '2026-03-01' && row.status === 'sent'));
    assert.equal((await h.deliverBirthdayEmails(now)).sent, 0);
    await h.db.prepare('DELETE FROM contact_children WHERE id = ?').bind(child!.id).run();
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_deliveries WHERE child_id = ?')
      .bind(child!.id).first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('a child birthday changed during quiet hours does not send the stale occasion', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    const parent = await h.db.prepare(`INSERT INTO contacts (workspace_id, name)
      VALUES ('test', 'Parent') RETURNING id`).first<{ id: number }>();
    const child = await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('test', ?, 'Child', '2000-10-09') RETURNING id`).bind(parent!.id).first<{ id: number }>();
    let sends = 0;
    h.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'unexpected' }; } };
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-01T12:00:00.000Z'))).queued, 0,
      'a child birthday eight days away is not queued');
    const quiet = await h.deliverBirthdayEmails(new Date('2026-10-02T23:00:00.000Z'));
    assert.equal(quiet.quiet, 1);
    await h.db.prepare("UPDATE contact_children SET birthday = '2000-11-09' WHERE id = ?").bind(child!.id).run();
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-03T08:00:00.000Z'))).sent, 0);
    assert.equal(sends, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_deliveries').first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('linking a child profile cancels queued child email and sends one contact birthday', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    const parent = (await h.call('contacts', { method: 'POST', body: { name: 'Parent' } })).body.contact;
    const profile = (await h.call('contacts', { method: 'POST', body: { name: 'Child profile', birthday: '2000-10-02', birthday_reminder_days: 0 } })).body.contact;
    const child = (await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: { name: 'Child', birthday: '2000-10-02' } })).body.child;
    const messages: Array<{ text: string }> = [];
    h.emailEnv.EMAIL = { send: async (message: { text: string }) => {
      messages.push(message);
      return { messageId: `linked-${messages.length}` };
    } };
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-02T23:00:00.000Z'))).quiet, 2);
    const linked = await h.call(`contacts/${parent.id}/children/${child.id}`, { method: 'PATCH', body: {
      name: child.name, birthday: child.birthday, linked_contact_id: profile.id, expected_updated_at: child.updated_at,
    } });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const result = await h.deliverBirthdayEmails(new Date('2026-10-03T08:00:00.000Z'));
    assert.equal(result.sent, 0, 'the prior-day occurrence should not be sent after its due date');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_deliveries WHERE child_id = ?')
      .bind(child.id).first<{ count: number }>())?.count, 0);
    assert.equal(messages.length, 0);
    const nextYear = await h.deliverBirthdayEmails(new Date('2027-10-02T12:00:00.000Z'));
    assert.equal(nextYear.sent, 1);
    assert.equal(nextYear.eventsSent, 1);
    assert.equal(messages.length, 1);
  } finally { await h.close(); }
});

test('restore requires fresh birthday email consent and erasure clears annual state', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Private birthday', '2000-10-02', 0)`).run();
    const parent = await h.db.prepare("SELECT id FROM contacts WHERE workspace_id = 'test' AND name = 'Private birthday'").first<{ id: number }>();
    await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('test', ?, 'Private child', '2000-10-02')`).bind(parent!.id).run();
    const backup = await h.call('settings/backups', { method: 'POST' });
    assert.equal(backup.status, 201);
    let sends = 0;
    h.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'birthday-before-restore' }; } };
    const now = new Date('2026-10-02T12:00:00.000Z');
    assert.equal((await h.deliverBirthdayEmails(now)).sent, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_scan_state').first<{ count: number }>())?.count, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM child_birthday_email_scan_state').first<{ count: number }>())?.count, 1);
    const restored = await h.call('settings/restore', {
      method: 'POST', body: { filename: backup.body.backup.filename, confirmation: 'RESTORE' },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_deliveries').first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_scan_state').first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM child_birthday_email_scan_state').first<{ count: number }>())?.count, 0);
    const preference = await h.db.prepare("SELECT enabled, enabled_at FROM reminder_email_preferences WHERE workspace_id = 'test'")
      .first<{ enabled: number; enabled_at: string | null }>();
    assert.deepEqual(preference, { enabled: 0, enabled_at: null });
    assert.equal((await h.deliverBirthdayEmails(now)).sent, 0);
    assert.equal(sends, 1);
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM reminder_email_preferences WHERE workspace_id = 'test'").first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('birthday edit during quiet hours cancels a stale annual email', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Private person', '2000-10-05', 3)`).run();
    let sends = 0;
    h.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'unexpected' }; } };
    const quiet = await h.deliverBirthdayEmails(new Date('2026-10-02T23:00:00.000Z'));
    assert.equal(quiet.quiet, 1);
    assert.equal(sends, 0);
    await h.db.prepare("UPDATE contacts SET birthday = '2000-11-05' WHERE workspace_id = 'test'").run();
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-03T08:00:00.000Z'))).sent, 0);
    assert.equal(sends, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM birthday_email_deliveries').first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('birthday email retries and delivery status are visible to the owner', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Person', '2000-10-03', 1)`).run();
    let calls = 0;
    h.emailEnv.EMAIL = { send: async () => {
      calls++;
      if (calls === 1) throw new Error('Provider unavailable');
      return { messageId: 'birthday-sent' };
    } };
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-02T12:00:00.000Z'))).failed, 1);
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-02T12:14:59.000Z'))).sent, 0);
    assert.equal((await h.deliverBirthdayEmails(new Date('2026-10-02T12:15:00.000Z'))).sent, 1);
    assert.equal(calls, 2);
    const response = await h.emailSettings(new Request('https://test.invalid/api/reminders/email-preferences'), 'test', 'birthday-user-1');
    assert.equal(response.status, 200);
    const settings = await response.json() as { lastSentAt: string | null; failedCount: number };
    assert.equal(settings.failedCount, 0);
    assert.equal(settings.lastSentAt, '2026-10-02T12:15:00.000Z');
  } finally { await h.close(); }
});

test('overlapping birthday scans send one annual event and reject cross-workspace links', async () => {
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Own', '2000-10-02', 0), ('other', 'Foreign', '2000-10-02', 0)`).run();
    const own = await h.db.prepare("SELECT id FROM contacts WHERE workspace_id = 'test' AND name = 'Own'").first<{ id: number }>();
    await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, birthday)
      VALUES ('test', ?, 'Own child', '2000-10-02')`).bind(own!.id).run();
    const foreign = await h.db.prepare("SELECT id FROM contacts WHERE workspace_id = 'other'").first<{ id: number }>();
    await assert.rejects(h.db.prepare(`INSERT INTO birthday_email_deliveries
      (workspace_id, user_id, contact_id, occurrence, next_attempt_at)
      VALUES ('test', 'birthday-user-1', ?, '2026-10-02', '2026-10-02T12:00:00.000Z')`).bind(foreign!.id).run());
    let sends = 0;
    h.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'birthday-once' }; } };
    const now = new Date('2026-10-02T12:00:00.000Z');
    const results = await Promise.all([h.deliverBirthdayEmails(now), h.deliverBirthdayEmails(now)]);
    assert.equal(results.reduce((count, result) => count + result.sent, 0), 1);
    assert.equal(results.reduce((count, result) => count + result.eventsSent, 0), 2);
    assert.equal(sends, 1);
  } finally { await h.close(); }
});

test('birthday scan cursor reaches a due contact beyond the first bounded page', async (t) => {
  if (process.env.CLOUD_TEST_RUNTIME === 'workerd') {
    t.skip('The large-count pagination boundary runs in the fast SQLite harness.');
    return;
  }
  const h = await createCloudHarness();
  try {
    await seed(h);
    await h.db.prepare(`INSERT INTO reminder_email_preferences
      (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour)
      VALUES ('test', 'birthday-user-1', 1, '2026-01-01T00:00:00.000Z', 'UTC', 22, 8)`).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      SELECT 'test', 'Not due', '2000-12-25', 0 FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({ length: 2_000 }, (_, index) => index))).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, birthday, birthday_reminder_days)
      VALUES ('test', 'Due last', '2000-10-02', 0)`).run();
    let sends = 0;
    h.emailEnv.EMAIL = { send: async () => { sends++; return { messageId: 'late-page' }; } };
    const now = new Date('2026-10-02T12:00:00.000Z');
    assert.equal((await h.deliverBirthdayEmails(now)).scanned, 2_000);
    assert.equal(sends, 0);
    assert.equal((await h.deliverBirthdayEmails(now)).scanned, 1);
    assert.equal(sends, 1);
  } finally { await h.close(); }
});
