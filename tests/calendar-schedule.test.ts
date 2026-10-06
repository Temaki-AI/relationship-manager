import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { calendarScheduleRevision, localCalendarScheduleRecord, readCalendarScheduleInput, rescheduleLocalCalendarEvent } from '../lib/calendar-schedule.ts';

function fixture() {
  const db = new Database(':memory:'); initializeDatabase(db);
  const person = Number(db.prepare("INSERT INTO contacts(name, notes) VALUES ('Local Calendar QA', 'Private relationship note')").run().lastInsertRowid);
  const plan = Number(db.prepare("INSERT INTO plans(contact_id, type, planned_date, summary, notes) VALUES (?, 'call', '2026-10-08', 'Catch up', 'Private plan note')").run(person).lastInsertRowid);
  const reminder = Number(db.prepare("INSERT INTO reminders(contact_id, title, remind_at, notes) VALUES (?, 'Check in', '2026-10-08T09:00:00.000Z', 'Private reminder note')").run(person).lastInsertRowid);
  return { db, plan, reminder };
}
test('local Calendar scheduling changes only the chosen date and retries without another effect', () => {
  const f = fixture();
  try {
    for (const kind of ['plan', 'reminder'] as const) {
      const id = f[kind], before = localCalendarScheduleRecord(f.db, kind, id)!;
      const field = kind === 'plan' ? 'planned_date' : 'remind_at';
      const input = readCalendarScheduleInput(kind, { calendar_schedule: { expected_revision: calendarScheduleRevision(kind, before), original_at: before[field], at: kind === 'plan' ? '2026-11-02' : '2026-11-02T16:30:00.000Z' } });
      const saved = rescheduleLocalCalendarEvent(f.db, kind, id, input);
      assert.equal(saved.dateChanged, true); assert.equal(saved.record[field], input.at);
      for (const key of Object.keys(before).filter((key) => key !== field)) assert.equal(saved.record[key], before[key], key);
      assert.equal(rescheduleLocalCalendarEvent(f.db, kind, id, input).dateChanged, false);
    }
    assert.equal((f.db.prepare('SELECT COUNT(*) count FROM interactions').get() as { count: number }).count, 0);
  } finally { f.db.close(); }
});
test('a local recovery epoch invalidates the earlier Calendar date review', () => {
  const f = fixture();
  try {
    const before = localCalendarScheduleRecord(f.db, 'plan', f.plan)!;
    const input = readCalendarScheduleInput('plan', { calendar_schedule: { expected_revision: calendarScheduleRevision('plan', before), original_at: before.planned_date, at: '2026-11-02' } });
    f.db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'source-write-epoch'").run(crypto.randomUUID());
    assert.throws(() => rescheduleLocalCalendarEvent(f.db, 'plan', f.plan, input), /changed after you opened/u);
    assert.equal(localCalendarScheduleRecord(f.db, 'plan', f.plan)!.planned_date, before.planned_date);
  } finally { f.db.close(); }
});
