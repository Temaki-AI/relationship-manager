import type { SQLiteDatabase } from 'expo-sqlite';
import { civilDaysBetween, dateInTimeZone, nextBirthdayOccurrence, startOfCivilDayUTC } from '../../../../packages/domain/src/civil-date';
import type { ContactRecord } from '@/domain/contact';
import type { InteractionRecord } from './contacts';
import type { ReminderRecord } from './reminders';

export const TODAY_QUEUE_SIZE = 8;
export type TodayReason = { kind: 'reminder' | 'birthday' | 'check-in'; title: string; detail: string };
export type TodayPerson = {
  contact: ContactRecord;
  reasons: TodayReason[];
  reminder: ReminderRecord | null;
  latestInteraction: InteractionRecord | null;
};
type Candidate = ContactRecord & {
  birthday_days: number;
  reminder_id: string | null;
  reminder_title: string | null;
  reminder_notes: string | null;
  remind_at: string | null;
  notification_id: string | null;
  interaction_id: string | null;
  interaction_type: InteractionRecord['type'] | null;
  interaction_date: string | null;
  interaction_occurred_at: string | null;
  interaction_summary: string | null;
};

function decorate(row: Candidate, today: string, timeZone: string): TodayPerson {
  const reasons: TodayReason[] = [];
  const reminder: ReminderRecord | null = row.reminder_id ? {
    id: row.reminder_id, contact_id: row.id, contact_name: row.name,
    title: row.reminder_title!, notes: row.reminder_notes, remind_at: row.remind_at!,
    notification_id: row.notification_id, completed_at: null,
  } : null;
  if (reminder) reasons.push({ kind: 'reminder', title: reminder.title, detail: 'Reminder' });
  const birthday = row.birthday && nextBirthdayOccurrence(row.birthday, today);
  if (birthday && birthday.daysUntil <= row.birthday_days) reasons.push({ kind: 'birthday',
    title: birthday.daysUntil === 0 ? 'Birthday today' : birthday.daysUntil === 1 ? 'Birthday tomorrow' : `Birthday in ${birthday.daysUntil} days`,
    detail: 'A little time to make it thoughtful.',
  });
  const latestInteraction: InteractionRecord | null = row.interaction_id ? {
    id: row.interaction_id, contact_id: row.id, type: row.interaction_type!, date: row.interaction_date!,
    occurred_at: row.interaction_occurred_at, summary: row.interaction_summary, notes: null,
  } : null;
  // A just-recorded interaction uses an instant. Its local day prevents an
  // immediate check-in prompt around UTC midnight; date-only history stays civil.
  const recordedDay = latestInteraction?.occurred_at
    ? dateInTimeZone(latestInteraction.occurred_at, timeZone) : latestInteraction?.date;
  let lastContacted = row.last_contacted;
  if (recordedDay && (!lastContacted || lastContacted <= latestInteraction!.date)) lastContacted = recordedDay;
  const elapsed = lastContacted ? civilDaysBetween(lastContacted, today) : null;
  if (elapsed === null || elapsed >= row.contact_frequency) reasons.push({ kind: 'check-in', title: 'Time for a check-in',
    detail: elapsed === null ? 'No conversation recorded yet.'
      : `Last connected ${elapsed === 1 ? '1 day' : `${elapsed} days`} ago · every ${row.contact_frequency} days.`,
  });
  return { contact: row, reasons, reminder, latestInteraction };
}

/** Read the relevant people directly, rather than taking the first People page. */
export async function getTodayQueue(db: SQLiteDatabase, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<TodayPerson[]> {
  const today = dateInTimeZone(now, timeZone);
  if (!today) throw new Error('Could not read today’s date.');
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const endOfToday = startOfCivilDayUTC(tomorrow.toISOString().slice(0, 10), timeZone);
  const people: TodayPerson[] = [];
  // A narrow one-day tolerance covers UTC interaction dates. Filter them by the
  // actual local day below, and keep paging if those exclusions fill a batch.
  for (let offset = 0; people.length < TODAY_QUEUE_SIZE; offset += 32) {
    const rows = await db.getAllAsync<Candidate>(`
      WITH due AS (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.contact_id ORDER BY julianday(r.remind_at), r.id) AS rank
        FROM reminders r JOIN contacts c ON c.id = r.contact_id
        WHERE r.deleted_at IS NULL AND r.completed_at IS NULL AND c.deleted_at IS NULL
          AND julianday(r.remind_at) < julianday(?)
      ), birthdays AS (
        SELECT c.*, CASE WHEN json_valid(remote.record_json) THEN
          COALESCE(json_extract(remote.record_json, '$.data.birthday_reminder_days'), 7) ELSE 7 END AS birthday_days,
          CASE WHEN length(c.birthday) = 10 AND date(c.birthday, '+0 days') = c.birthday THEN
            date(substr(?, 1, 4) || substr(c.birthday, 5), '+0 days') END AS this_birthday
        FROM contacts c LEFT JOIN sync_remote_contacts remote ON remote.id = c.id
        WHERE c.deleted_at IS NULL
      ), occasions AS (
        SELECT b.*, CASE WHEN this_birthday < ? THEN
          date(CAST(CAST(substr(?, 1, 4) AS INTEGER) + 1 AS TEXT) || substr(b.birthday, 5), '+0 days')
          ELSE this_birthday END AS next_birthday
        FROM birthdays b
      )
      SELECT c.*, r.id AS reminder_id, r.title AS reminder_title, r.notes AS reminder_notes,
        r.remind_at, r.notification_id, i.id AS interaction_id, i.type AS interaction_type,
        i.date AS interaction_date, i.occurred_at AS interaction_occurred_at, i.summary AS interaction_summary
      FROM occasions c LEFT JOIN due r ON r.contact_id = c.id AND r.rank = 1
      LEFT JOIN interactions i ON i.id = (
        SELECT recent.id FROM interactions recent WHERE recent.contact_id = c.id AND recent.deleted_at IS NULL
        ORDER BY recent.date DESC, COALESCE(recent.occurred_at, '') DESC, recent.id DESC LIMIT 1
      )
      WHERE r.id IS NOT NULL OR julianday(c.next_birthday) - julianday(?) BETWEEN 0 AND c.birthday_days
        OR c.last_contacted IS NULL OR julianday(?) - julianday(c.last_contacted) + 1 >= c.contact_frequency
      ORDER BY CASE WHEN r.id IS NOT NULL THEN 0
        WHEN julianday(c.next_birthday) - julianday(?) BETWEEN 0 AND c.birthday_days THEN 1 ELSE 2 END,
        julianday(r.remind_at), CASE WHEN julianday(c.next_birthday) - julianday(?) BETWEEN 0 AND c.birthday_days
          THEN julianday(c.next_birthday) END,
        COALESCE(julianday(c.last_contacted) - julianday(?) + c.contact_frequency, -999999), c.id
      LIMIT 32 OFFSET ?
    `, endOfToday, today, today, today, today, today, today, today, today, offset);
    for (const row of rows) {
      const person = decorate(row, today, timeZone);
      if (person.reasons.length) people.push(person);
      if (people.length === TODAY_QUEUE_SIZE) break;
    }
    if (rows.length < 32) break;
  }
  return people;
}
