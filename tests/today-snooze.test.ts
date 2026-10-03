import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { parseTodaySnoozeTarget, parseTodaySnoozeUntil } from '../lib/today-snooze.ts';
import { deleteLocalTodaySnooze, putLocalTodaySnooze, TodaySnoozeError } from '../lib/today-snooze-store.ts';

test('today snooze validation bounds dates and accepts only known prompt IDs', () => {
  const now = new Date('2026-04-12T12:00:00Z');
  assert.deepEqual(parseTodaySnoozeTarget('reminder-42'), { kind: 'reminder', id: 42 });
  for (const id of ['reminder-0', 'overdue-01', 'birthday-abc', 'signal-1', 'reminder-999999999999999999999']) {
    assert.equal(parseTodaySnoozeTarget(id), null);
  }
  assert.equal(parseTodaySnoozeUntil('2026-04-19', now, 'UTC'), '2026-04-19');
  assert.equal(parseTodaySnoozeUntil('2026-04-12', now, 'UTC'), null);
  assert.equal(parseTodaySnoozeUntil('2026-05-13', now, 'UTC'), null);
  assert.equal(parseTodaySnoozeUntil('2026-04-31', now, 'UTC'), null);
});

test('local snoozes are idempotent and cascade with their source', () => {
  const db = new Database(':memory:');
  try {
    initializeDatabase(db);
    const contactId = Number(db.prepare("INSERT INTO contacts(name, birthday) VALUES ('Ada', '1990-04-14')").run().lastInsertRowid);
    const reminderId = Number(db.prepare("INSERT INTO reminders(contact_id, title, remind_at) VALUES (?, 'Call Ada', '2026-04-12T10:00:00Z')").run(contactId).lastInsertRowid);
    const itemId = `reminder-${reminderId}`;
    const target = parseTodaySnoozeTarget(itemId)!;
    assert.equal(putLocalTodaySnooze(db, itemId, target, '2026-04-19', '2026-04-12').reminder_id, reminderId);
    assert.equal(putLocalTodaySnooze(db, itemId, target, '2026-04-20', '2026-04-12').until_date, '2026-04-20');
    assert.equal((db.prepare('SELECT COUNT(*) total FROM daily_snoozes').get() as { total: number }).total, 1);
    db.prepare('UPDATE reminders SET completed_at = ? WHERE id = ?').run('2026-04-12T12:00:00Z', reminderId);
    assert.throws(() => putLocalTodaySnooze(db, itemId, target, '2026-04-21', '2026-04-12'), TodaySnoozeError);
    deleteLocalTodaySnooze(db, itemId);
    deleteLocalTodaySnooze(db, itemId);
    putLocalTodaySnooze(db, `birthday-${contactId}`, { kind: 'birthday', id: contactId }, '2026-04-19', '2026-04-12');
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
    assert.equal((db.prepare('SELECT COUNT(*) total FROM daily_snoozes').get() as { total: number }).total, 0);
  } finally { db.close(); }
});
