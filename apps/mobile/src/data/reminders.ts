import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import { normalizeReminderDraft, type ReminderDraft } from '@/domain/reminder';
import { enqueueSyncIntent } from './sync-queue';

export type ReminderRecord = {
  id: string;
  contact_id: string;
  contact_name: string;
  title: string;
  notes: string | null;
  remind_at: string;
  completed_at: string | null;
  notification_id: string | null;
};

export async function listOpenReminders(
  db: SQLiteDatabase,
  contactId?: string
): Promise<ReminderRecord[]> {
  const whereContact = contactId ? 'AND reminders.contact_id = ?' : '';
  return db.getAllAsync<ReminderRecord>(`
    SELECT
      reminders.id,
      reminders.contact_id,
      contacts.name contact_name,
      reminders.title,
      reminders.notes,
      reminders.remind_at,
      reminders.completed_at,
      reminders.notification_id
    FROM reminders
    JOIN contacts ON contacts.id = reminders.contact_id
    WHERE reminders.deleted_at IS NULL
      AND reminders.completed_at IS NULL
      AND contacts.deleted_at IS NULL
      ${whereContact}
    ORDER BY reminders.remind_at, reminders.id
    LIMIT 500
  `, ...(contactId ? [contactId] : []));
}

export async function getNextReminder(db: SQLiteDatabase): Promise<ReminderRecord | null> {
  const reminders = await listOpenReminders(db);
  return reminders[0] ?? null;
}

export async function createReminder(
  db: SQLiteDatabase,
  draft: ReminderDraft,
  notificationId: string | null
): Promise<ReminderRecord> {
  const input = normalizeReminderDraft(draft);
  const id = Crypto.randomUUID();
  const now = new Date().toISOString();

  const contact = await db.getFirstAsync<{ name: string }>(
    'SELECT name FROM contacts WHERE id = ? AND deleted_at IS NULL',
    input.contactId
  );
  if (!contact) throw new Error('Choose an available contact for this reminder.');

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(`
      INSERT INTO reminders (
        id, contact_id, title, notes, remind_at, notification_id,
        created_at, updated_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    id,
    input.contactId,
    input.title,
    input.notes,
    input.remindAt,
    notificationId,
    now,
    now);
    await enqueueSyncIntent(transaction, 'reminder', id, 'create', input, now);
  });

  return {
    id,
    contact_id: input.contactId,
    contact_name: contact.name,
    title: input.title,
    notes: input.notes,
    remind_at: input.remindAt,
    completed_at: null,
    notification_id: notificationId,
  };
}

export async function completeReminder(
  db: SQLiteDatabase,
  reminderId: string
): Promise<string | null> {
  const reminder = await db.getFirstAsync<{ notification_id: string | null }>(`
    SELECT notification_id
    FROM reminders
    WHERE id = ? AND completed_at IS NULL AND deleted_at IS NULL
  `, reminderId);
  if (!reminder) return null;

  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(`
      UPDATE reminders
      SET completed_at = ?, updated_at = ?, sync_state = 'pending'
      WHERE id = ? AND completed_at IS NULL AND deleted_at IS NULL
    `, now, now, reminderId);
    await enqueueSyncIntent(transaction, 'reminder', reminderId, 'update', {
      completedAt: now,
    }, now);
  });
  return reminder.notification_id;
}
