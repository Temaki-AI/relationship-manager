import type Database from 'better-sqlite3';
import { MAX_ACTIVE_TODAY_SNOOZES, type TodaySnooze, type TodaySnoozeTarget } from './today-snooze.ts';

export class TodaySnoozeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function putLocalTodaySnooze(db: Database.Database, itemId: string, target: TodaySnoozeTarget, untilDate: string, today: string): TodaySnooze {
  const save = db.transaction(() => {
    const source = target.kind === 'reminder'
      ? db.prepare('SELECT contact_id, id AS reminder_id FROM reminders WHERE id = ? AND completed_at IS NULL').get(target.id) as { contact_id: number; reminder_id: number } | undefined
      : db.prepare(`SELECT id AS contact_id, NULL AS reminder_id FROM contacts WHERE id = ? ${target.kind === 'birthday' ? 'AND birthday IS NOT NULL' : ''}`).get(target.id) as { contact_id: number; reminder_id: null } | undefined;
    if (!source) throw new TodaySnoozeError('This prompt is no longer available.', 404);
    const existing = db.prepare('SELECT 1 FROM daily_snoozes WHERE id = ?').get(itemId);
    if (!existing) {
      const count = db.prepare('SELECT COUNT(*) AS total FROM daily_snoozes WHERE until_date > ?').get(today) as { total: number };
      if (count.total >= MAX_ACTIVE_TODAY_SNOOZES) throw new TodaySnoozeError('Too many snoozed prompts. Bring one back before snoozing another.', 409);
    }
    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO daily_snoozes (id, contact_id, reminder_id, until_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET contact_id = excluded.contact_id, reminder_id = excluded.reminder_id,
        until_date = excluded.until_date, updated_at = excluded.updated_at`)
      .run(itemId, source.contact_id, source.reminder_id, untilDate, updatedAt, updatedAt);
    return db.prepare('SELECT id, contact_id, reminder_id, until_date FROM daily_snoozes WHERE id = ?').get(itemId) as TodaySnooze;
  });
  return save.immediate();
}

export function deleteLocalTodaySnooze(db: Database.Database, itemId: string): void {
  db.prepare('DELETE FROM daily_snoozes WHERE id = ?').run(itemId);
}
