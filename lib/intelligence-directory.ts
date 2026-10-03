import type Database from 'better-sqlite3';
import type { Workspace } from './db.ts';
import type {
  ContactActivitySummary,
  IntelligenceContact,
  IntelligenceInteraction,
  IntelligenceReminder,
} from './intelligence.ts';
import type { TodaySnooze } from './today-snooze.ts';

type ActivityRow = IntelligenceInteraction & {
  interactions_count: number;
};

type CountRow = {
  count: number;
};

const CONTACT_SIGNAL_QUERY = `
  SELECT
    id,
    name,
    email,
    phone,
    birthday,
    birthday_reminder_days,
    tags,
    custom_fields,
    last_contacted,
    contact_frequency,
    created_at,
    updated_at
  FROM contacts
  ORDER BY updated_at DESC, id DESC
`;

const ACTIVE_SNOOZE_QUERY = `
  SELECT s.id, s.contact_id, s.reminder_id, s.until_date,
    c.name AS contact_name, r.title AS reminder_title
  FROM daily_snoozes s
  JOIN contacts c ON c.id = s.contact_id
  LEFT JOIN reminders r ON r.id = s.reminder_id
  WHERE s.until_date > ? AND (s.reminder_id IS NULL OR r.completed_at IS NULL)
  ORDER BY s.until_date, s.id
`;

const CONTACT_ACTIVITY_QUERY = `
  WITH ranked_interactions AS (
    SELECT
      id,
      contact_id,
      date,
      type,
      summary,
      COUNT(*) OVER (PARTITION BY contact_id) AS interactions_count,
      ROW_NUMBER() OVER (
        PARTITION BY contact_id
        ORDER BY date DESC, id DESC
      ) AS interaction_rank
    FROM interactions
  )
  SELECT id, contact_id, date, type, summary, interactions_count
  FROM ranked_interactions
  WHERE interaction_rank = 1
`;

function readSignalData(db: Database.Database, today: string) {
  const contacts = db.prepare(CONTACT_SIGNAL_QUERY).all() as IntelligenceContact[];
  const snoozes = db.prepare(ACTIVE_SNOOZE_QUERY).all(today) as TodaySnooze[];
  const activityRows = db.prepare(CONTACT_ACTIVITY_QUERY).all() as ActivityRow[];
  const activity = new Map<number, ContactActivitySummary>();

  for (const row of activityRows) {
    activity.set(row.contact_id, {
      contactId: row.contact_id,
      interactionsCount: row.interactions_count,
      latestInteraction: {
        id: row.id,
        contact_id: row.contact_id,
        date: row.date,
        type: row.type,
        summary: row.summary,
      },
      openReminders: [],
    });
  }

  return { contacts, activity, snoozes };
}

export function loadSmartListData(db: Database.Database, today: string) {
  return db.transaction(() => readSignalData(db, today))();
}

export function loadIntelligenceOverviewData(db: Database.Database, today: string) {
  return db.transaction(() => {
    const signalData = readSignalData(db, today);
    const workspace = db.prepare(
      'SELECT id, name, plan, persona, created_at FROM workspaces ORDER BY id LIMIT 1'
    ).get() as Workspace | undefined;
    const feedReminders = db.prepare(`
      WITH ranked AS (
        SELECT r.id, r.contact_id, r.title, r.remind_at, r.completed_at,
          ROW_NUMBER() OVER (PARTITION BY r.contact_id ORDER BY julianday(r.remind_at), r.id) AS contact_rank
        FROM reminders r
        WHERE r.completed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM daily_snoozes s
          WHERE s.id = 'reminder-' || r.id AND s.until_date > ?
        )
      )
      SELECT id, contact_id, title, remind_at, completed_at FROM ranked
      WHERE contact_rank = 1
      ORDER BY julianday(remind_at) ASC, id ASC
      LIMIT 4
    `).all(today) as IntelligenceReminder[];
    const openReminderCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM reminders
      WHERE completed_at IS NULL
    `).get() as CountRow).count;

    return {
      ...signalData,
      workspace,
      feedReminders,
      openReminderCount,
    };
  })();
}
