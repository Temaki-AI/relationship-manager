import assert from 'node:assert/strict';
import test from 'node:test';
import { todaySnoozeFixture } from './helpers/today-snooze-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { isNativeDeviceApiPath } from '../packages/domain/src/devices.ts';
import { promptUntil, readPromptMutation, readPromptSnapshot, readPromptAcknowledgement, type PromptMutation } from '../packages/domain/src/today-snoozes.ts';

test('shared prompt dates use local civil days and strict bounded identity/snapshot/acknowledgement contracts', () => {
  assert.equal(promptUntil(1, new Date('2026-03-29T00:30:00Z'), 'Europe/Lisbon'), '2026-03-30');
  assert.equal(promptUntil(1, new Date('2026-10-05T01:00:00Z'), 'America/Los_Angeles'), '2026-10-05');
  assert.throws(() => promptUntil(31));
  const mutation: PromptMutation = { version: 1, operationId: crypto.randomUUID(), epoch: crypto.randomUUID(), targetId: crypto.randomUUID(), kind: 'birthday', baseUntilDate: null, untilDate: '2026-10-06', timeZone: 'UTC' };
  assert.deepEqual(readPromptMutation(mutation), mutation);
  assert.throws(() => readPromptMutation({ ...mutation, untilDate: '2026-02-30' }));
  assert.throws(() => readPromptMutation({ ...mutation, privateNotes: 'Not a preference' }));
  assert.throws(() => readPromptSnapshot({ version: 1, epoch: mutation.epoch, snoozes: [{ kind: 'birthday', targetId: mutation.targetId, contactId: crypto.randomUUID(), untilDate: mutation.untilDate }] }, mutation.epoch));
  assert.throws(() => readPromptSnapshot({ version: 1, epoch: crypto.randomUUID(), snoozes: [] }, mutation.epoch));
  assert.throws(() => readPromptAcknowledgement({ version: 1, operationId: mutation.operationId, epoch: mutation.epoch, kind: mutation.kind, targetId: crypto.randomUUID(), untilDate: mutation.untilDate }, mutation));
  assert.equal(getCloudApiRewrite('/api/v1/today-snoozes'), '/api/cloud/v1/today-snoozes');
  assert.equal(isNativeDeviceApiPath('/api/v1/today-snoozes'), true);
  assert.equal(isNativeDeviceApiPath('/api/v1/today-snoozes/extra'), false);
});

test('web snoozes reach the phone by public identity, hide only their reason and return on their local day', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core();
    const tomorrow = promptUntil(1, new Date(), 'UTC');
    assert.equal((await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: tomorrow, timeZone: 'UTC' } })).status, 200);
    await f.sync();
    const now = new Date(), queue = await f.phone.today.getTodayQueue(f.phone.db, now, 'UTC');
    assert.deepEqual(queue[0].reasons.map((r) => r.kind), ['check-in']);
    const saved = await f.phone.todaySnoozes.listSnoozedPrompts(f.phone.db, now, 'UTC'); assert.equal(saved[0].target_id, p.publicId);
    assert.equal(saved[0].contact_name, 'Ana'); assert.equal(saved[0].until_date, tomorrow);
    await f.restart(); assert.deepEqual((await f.phone.today.getTodayQueue(f.phone.db, now, 'UTC'))[0].reasons.map((r) => r.kind), ['check-in']);
    // Future expiry is local civil midnight, not 24 hours after choosing Snooze.
    const expiry = new Date(tomorrow + 'T12:00:00Z');
    assert.equal((await f.phone.todaySnoozes.listSnoozedPrompts(f.phone.db, expiry, 'UTC')).length, 0);
    assert.equal((await f.cloud.call('today/snooze', { method: 'DELETE', body: { id: `birthday-${p.id}` } })).status, 200);
    await f.sync(); assert.ok((await f.phone.today.getTodayQueue(f.phone.db, now, 'UTC'))[0].reasons.some((r) => r.kind === 'birthday'));
    assert.equal((await f.phone.contacts.getContact(f.phone.db, p.publicId))!.notes, 'Private memory');
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.publicId)).length, 0);
  } finally { await f.close(); }
});

test('offline native choices save atomically, survive restart, synchronize to web and bring back only that prompt', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    const until = promptUntil(7, new Date(), 'UTC');
    f.phone.faults.sqlContains = 'INSERT INTO today_snooze_queue';
    await assert.rejects(f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, until, { timeZone: 'UTC' }));
    f.phone.faults.sqlContains = undefined;
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snoozes').get().n, 0);
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, until, { timeZone: 'UTC' });
    await f.restart(); assert.deepEqual((await f.phone.today.getTodayQueue(f.phone.db, new Date(), 'UTC'))[0].reasons.map((r) => r.kind), ['birthday']);
    await f.sync();
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind('test', `overdue-${p.id}`).first<{ until_date: string }>())!.until_date, until);
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, null, { timeZone: 'UTC' }); await f.sync();
    assert.equal(await f.cloud.db.prepare('SELECT id FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind('test', `overdue-${p.id}`).first(), null);
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.publicId)).length, 0);
    assert.equal((await f.phone.contacts.getContact(f.phone.db, p.publicId))!.notes, 'Private memory');
  } finally { await f.close(); }
});

test('a lost reply retries the exact operation after later web choices, expiry or target removal without reapplying it', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'birthday', p.publicId, promptUntil(1, new Date(), 'UTC'), { timeZone: 'UTC' });
    let original = '';
    await assert.rejects(f.sync(async (input, init) => {
      if (init?.method === 'POST') { original = String(init.body); await f.transport(input, init); throw new Error('Lost committed response'); }
      return f.transport(input, init);
    }));
    assert.ok(original); const later = promptUntil(7, new Date(), 'UTC');
    await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: later, timeZone: 'UTC' } });
    await f.restart(); await f.sync();
    assert.ok(f.requests.filter((r) => r.body === original).length >= 2);
    assert.equal(f.phone.sqlite.prepare('SELECT until_date FROM today_snoozes').get().until_date, later);
    const body = JSON.parse(original) as PromptMutation, actor = { ...f.account, authMethod: 'device' as const, lifecycle: 'active' };
    const before = await f.cloud.db.prepare('SELECT * FROM daily_snoozes').all();
    await f.cloud.todaySnoozeSync.pushPromptSnooze(f.cloud.db, actor, body, new Date('2099-01-01T00:00:00Z'));
    assert.deepEqual(await f.cloud.db.prepare('SELECT * FROM daily_snoozes').all(), before);
    await f.cloud.call('contacts/' + p.id, { method: 'DELETE' });
    assert.equal((await f.push(body)).status, 200);
    assert.equal((await f.push({ ...body, untilDate: later })).status, 409);
  } finally { await f.close(); }
});

test('overlapping web and phone choices retain the iPhone intent until an explicit, fresh review', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    const phoneUntil = promptUntil(1, new Date(), 'UTC'), webUntil = promptUntil(7, new Date(), 'UTC');
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'birthday', p.publicId, phoneUntil, { timeZone: 'UTC' });
    await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: webUntil, timeZone: 'UTC' } }); await f.sync();
    const review = await f.phone.todaySnoozes.getPromptReview(f.phone.db, 'birthday', p.publicId);
    assert.equal(review.until_date, phoneUntil); assert.equal(review.remote_until_date, webUntil); assert.ok(review.conflict);
    const newer = promptUntil(30, new Date(), 'UTC'); await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: newer, timeZone: 'UTC' } }); await f.sync();
    await assert.rejects(f.phone.todaySnoozes.resolvePromptReview(f.phone.db, f.account, review, 'phone'), { code: 'review_changed' });
    const current = await f.phone.todaySnoozes.getPromptReview(f.phone.db, 'birthday', p.publicId);
    await f.phone.todaySnoozes.resolvePromptReview(f.phone.db, f.account, current, 'phone'); await f.sync();
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes').first<{ until_date: string }>())!.until_date, phoneUntil);
  } finally { await f.close(); }
});

test('incomplete downloads, incorrect acknowledgements and account changes cannot replace saved choices or consume an uncertain intent', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, promptUntil(7, new Date(), 'UTC'), { timeZone: 'UTC' });
    const before = f.phone.sqlite.prepare('SELECT * FROM today_snoozes').all();
    await assert.rejects(f.sync(async () => Response.json({ version: 1, epoch: f.epoch, snoozes: [{}] })), { code: 'invalid_snapshot' });
    assert.deepEqual(f.phone.sqlite.prepare('SELECT * FROM today_snoozes').all(), before);
    await assert.rejects(f.sync(async (input, init) => init?.method === 'POST' ? Response.json({ version: 1 }) : f.transport(input, init)), { code: 'invalid_ack' });
    const frozen = f.phone.sqlite.prepare('SELECT request_json FROM today_snooze_queue').get().request_json; assert.ok(frozen);
    let current = true;
    await assert.rejects(f.sync(async (input, init) => { const response = await f.transport(input, init); if (init?.method === 'POST') current = false; return response; }, () => current), { code: 'account_changed' });
    assert.equal(f.phone.sqlite.prepare('SELECT request_json FROM today_snooze_queue').get().request_json, frozen);
    await f.sync(); assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
  } finally { await f.close(); }
});

test('newer offline choices wait for the frozen receipt and remain intact when that reply was lost', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    const first = promptUntil(1, new Date(), 'UTC'), second = promptUntil(7, new Date(), 'UTC');
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, first, { timeZone: 'UTC' });
    let original = '';
    await assert.rejects(f.sync(async (input, init) => {
      if (init?.method === 'POST') { original = String(init.body); await f.transport(input, init); throw new Error('Lost reply'); }
      return f.transport(input, init);
    }));
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.publicId, second, { timeZone: 'UTC' });
    assert.equal(f.phone.sqlite.prepare('SELECT request_json FROM today_snooze_queue ORDER BY rowid LIMIT 1').get().request_json, original);
    await f.restart(); await f.sync();
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes').first<{ until_date: string }>())!.until_date, second);
    assert.equal(f.phone.sqlite.prepare('SELECT until_date FROM today_snoozes').get().until_date, second);
  } finally { await f.close(); }
});

test('restoring real cloud data holds earlier offline preferences until current choices are explicitly reviewed', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(), webUntil = promptUntil(7, new Date(), 'UTC'); await f.core();
    await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: webUntil, timeZone: 'UTC' } }); await f.sync();
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'birthday', p.publicId, promptUntil(1, new Date(), 'UTC'), { timeZone: 'UTC' });
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    await f.core();
    assert.equal(f.phone.sqlite.prepare('SELECT last_error_code FROM today_snooze_queue').get().last_error_code, 'epoch_changed');
    assert.equal((await f.phone.todaySnoozes.getPromptReview(f.phone.db, 'birthday', p.publicId)).cloudKnown, false);
    await f.sync(); const review = await f.phone.todaySnoozes.getPromptReview(f.phone.db, 'birthday', p.publicId);
    assert.ok(review.conflict && review.cloudKnown); assert.equal(review.remote_until_date, webUntil);
    await f.phone.todaySnoozes.resolvePromptReview(f.phone.db, f.account, review, 'cloud');
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
    assert.equal((await f.phone.contacts.getContact(f.phone.db, p.publicId))!.notes, 'Private memory');
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.publicId)).length, 0);
  } finally { await f.close(); }
});

test('an expired existing web row cannot exceed the active limit, and the complete boundary snapshot remains readable', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(), until = promptUntil(7, new Date(), 'UTC');
    await f.cloud.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 500)
      INSERT INTO contacts (workspace_id, name, birthday) SELECT 'test', 'Capacity ' || n, '1990-01-01' FROM numbers`).run();
    await f.cloud.db.prepare(`INSERT INTO daily_snoozes (workspace_id, id, contact_id, until_date)
      SELECT 'test', 'birthday-' || id, id, ? FROM contacts WHERE workspace_id = 'test' AND name LIKE 'Capacity %'`).bind(until).run();
    await f.cloud.db.prepare('INSERT INTO daily_snoozes (workspace_id, id, contact_id, until_date) VALUES (?, ?, ?, ?)').bind('test', `birthday-${p.id}`, p.id, '2000-01-01').run();
    assert.equal((await f.push(f.mutation('birthday', p.publicId))).body.code, 'prompt_capacity');
    assert.equal((await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until, timeZone: 'UTC' } })).status, 409);
    const response = await f.cloud.call('v1/today-snoozes?epoch=' + f.epoch + '&timeZone=UTC', { headers: { Authorization: `Bearer ${f.account.token}` } });
    assert.equal(response.status, 200); assert.equal(readPromptSnapshot(response.body, f.epoch).length, 500);
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes WHERE id = ?').bind(`birthday-${p.id}`).first<{ until_date: string }>())!.until_date, '2000-01-01');
  } finally { await f.close(); }
});

test('schema 16 migration preserves the existing journal and rolls back a failed preference-table creation', async () => {
  const f = await todaySnoozeFixture(); try {
    const local = await f.phone.contacts.createContact(f.phone.db, { name: 'Migration person', notes: 'Keep this private note' });
    await f.phone.reminders.createReminder(f.phone.db, { contactId: local.id, title: 'Keep my reminder', remindAt: new Date(Date.now() + 86_400_000) }, null);
    f.phone.sqlite.exec("DROP TABLE apple_calendar_reservations; DROP TABLE today_snooze_queue; DROP TABLE today_snoozes; PRAGMA user_version = 15; UPDATE app_metadata SET value = '15' WHERE key = 'schema-version';");
    const tables = f.phone.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'app_metadata' ORDER BY name").all().map((r: { name: string }) => r.name);
    const before = Object.fromEntries(tables.map((name: string) => [name, f.phone.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const failed = { ...f.phone.db, execAsync: async (sql: string) => { if (sql.includes('CREATE TABLE today_snoozes')) throw new Error('Injected migration failure'); return f.phone.db.execAsync(sql); },
      withExclusiveTransactionAsync: async (task: (db: typeof f.phone.db) => Promise<void>) => f.phone.db.withExclusiveTransactionAsync(async (tx) => task({ ...tx, execAsync: async (sql: string) => { if (sql.includes('CREATE TABLE today_snoozes')) throw new Error('Injected migration failure'); return tx.execAsync(sql); } })) };
    await assert.rejects(f.phone.database.migrateDatabase(failed));
    assert.equal(f.phone.sqlite.pragma('user_version', { simple: true }), 15);
    assert.equal(f.phone.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'today_snoozes'").get(), undefined);
    await f.phone.database.migrateDatabase(f.phone.db);
    assert.equal(f.phone.sqlite.pragma('user_version', { simple: true }), 17);
    assert.equal(f.phone.sqlite.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(Object.fromEntries(tables.map((name: string) => [name, f.phone.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])), before);
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
  } finally { await f.close(); }
});

test('a snooze chosen before publishing a new person waits for that durable CRM identity', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.phone.contacts.createContact(f.phone.db, { name: 'Created offline first', notes: 'Private before linking sources' });
    const until = promptUntil(7, new Date(), 'UTC');
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'overdue', p.id, until, { timeZone: 'UTC' });
    await f.sync();
    assert.equal(f.phone.sqlite.prepare('SELECT request_json FROM today_snooze_queue').get().request_json, null);
    assert.ok(!f.requests.some((request) => request.path === 'v1/today-snoozes' && request.body));
    await f.core(); await f.sync();
    const cloud = await f.cloud.db.prepare('SELECT id, notes FROM contacts WHERE workspace_id = ? AND public_id = ?').bind('test', p.id).first<{ id: number; notes: string }>();
    assert.equal(cloud!.notes, 'Private before linking sources');
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind('test', `overdue-${cloud!.id}`).first<{ until_date: string }>())!.until_date, until);
    assert.equal(f.phone.sqlite.prepare('SELECT COUNT(*) n FROM today_snooze_queue').get().n, 0);
  } finally { await f.close(); }
});

test('revocation inside the atomic write window leaves neither a preference nor an applied receipt', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(), body = f.mutation('birthday', p.publicId), original = f.cloud.db;
    let batches = 0;
    const fenced = { prepare: (sql: string) => original.prepare(sql), batch: async (statements: Parameters<typeof original.batch>[0]) => {
      if (++batches === 2) await original.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.account.deviceId).run();
      return original.batch(statements);
    } } as unknown as Parameters<typeof f.cloud.todaySnoozeSync.pushPromptSnooze>[0];
    await assert.rejects(f.cloud.todaySnoozeSync.pushPromptSnooze(fenced, { ...f.account, authMethod: 'device', lifecycle: 'active' }, body), { code: 'unauthorized' });
    assert.equal(await original.prepare('SELECT id FROM daily_snoozes WHERE workspace_id = ?').bind('test').first(), null);
    assert.equal(await original.prepare('SELECT operation_id FROM sync_mutation_receipts WHERE operation_id = ?').bind(`today:${body.operationId}`).first(), null);
  } finally { await f.close(); }
});

test('revoked sessions and restored epochs cannot replay or publish another account’s prompt choices', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(), body = f.mutation('birthday', p.publicId); assert.equal((await f.push(body)).status, 200);
    await f.cloud.db.prepare('UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), 'test').run();
    assert.equal((await f.push(body)).body.code, 'epoch_changed');
    await f.cloud.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.account.deviceId).run();
    assert.equal((await f.push(body)).status, 401);
    assert.equal((await f.cloud.call('v1/today-snoozes?epoch=' + f.epoch)).status, 403);
  } finally { await f.close(); }
});

test('a fresh conflict choice after travel uses the current civil day and zone rather than the earlier frozen intent', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(); await f.core(); await f.sync();
    const now = new Date(), oldZone = 'America/Los_Angeles', currentZone = 'Pacific/Kiritimati';
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'birthday', p.publicId, promptUntil(1, now, oldZone), { timeZone: oldZone });
    await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `birthday-${p.id}`, until: promptUntil(7, now, 'UTC'), timeZone: 'UTC' } }); await f.sync();
    const original = f.phone.sqlite.prepare('SELECT request_json FROM today_snooze_queue').get().request_json;
    const review = await f.phone.todaySnoozes.getPromptReview(f.phone.db, 'birthday', p.publicId), replacement = promptUntil(30, now, currentZone);
    await f.phone.todaySnoozes.resolvePromptReview(f.phone.db, f.account, review, 'phone', () => true, replacement, { now, timeZone: currentZone });
    const fresh = f.phone.sqlite.prepare('SELECT * FROM today_snooze_queue').get();
    assert.equal(fresh.time_zone, currentZone); assert.equal(fresh.until_date, replacement); assert.equal(fresh.request_json, null);
    assert.notEqual(fresh.id, JSON.parse(original).operationId);
    await f.sync();
    assert.equal((await f.cloud.db.prepare('SELECT until_date FROM daily_snoozes').first<{ until_date: string }>())!.until_date, replacement);
  } finally { await f.close(); }
});

test('a web reminder snooze reveals the next due task without moving reminders or hiding birthday and check-in reasons', async () => {
  const f = await todaySnoozeFixture(); try {
    const p = await f.person(), due = new Date(Date.now() - 60_000).toISOString();
    const first = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: p.id, title: 'First task', remind_at: new Date(Date.now() - 600_000).toISOString() } })).body.reminder;
    const second = (await f.cloud.call('reminders', { method: 'POST', body: { contact_id: p.id, title: 'Second task', remind_at: due } })).body.reminder;
    await f.core(); await f.sync();
    const before = f.phone.sqlite.prepare('SELECT id, remind_at, completed_at FROM reminders ORDER BY id').all();
    await f.cloud.call('today/snooze', { method: 'PUT', body: { id: `reminder-${first.id}`, until: promptUntil(7, new Date(), 'UTC'), timeZone: 'UTC' } }); await f.sync();
    const queue = await f.phone.today.getTodayQueue(f.phone.db, new Date(), 'UTC');
    const person = queue.find((item) => item.contact.id === p.publicId)!;
    assert.equal(person.reminder!.id, f.phone.sqlite.prepare('SELECT id FROM reminders WHERE remote_id = ?').get(second.id).id);
    assert.ok(person.reasons.some((reason) => reason.kind === 'birthday') && person.reasons.some((reason) => reason.kind === 'check-in'));
    assert.deepEqual(f.phone.sqlite.prepare('SELECT id, remind_at, completed_at FROM reminders ORDER BY id').all(), before);
    const saved = (await f.phone.todaySnoozes.listSnoozedPrompts(f.phone.db, new Date(), 'UTC'))[0];
    await f.phone.todaySnoozes.savePromptSnooze(f.phone.db, f.account, 'reminder', saved.target_id, null, { timeZone: 'UTC' }); await f.sync();
    assert.equal((await f.phone.today.getTodayQueue(f.phone.db, new Date(), 'UTC')).find((item) => item.contact.id === p.publicId)!.reminder!.id,
      f.phone.sqlite.prepare('SELECT id FROM reminders WHERE remote_id = ?').get(first.id).id);
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.publicId)).length, 0);
  } finally { await f.close(); }
});
