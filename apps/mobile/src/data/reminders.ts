import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import { normalizeReminderDraft, type ReminderDraft } from '@/domain/reminder';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
import { canonicalContactId } from './contact-aliases';
import { clearJournalDraft } from './journal-drafts';

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
  if (contactId) contactId = await canonicalContactId(db, contactId);
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
  notificationId: string | null,
  draftKey?: string
): Promise<ReminderRecord> {
  const input = normalizeReminderDraft(draft);
  input.contactId = await canonicalContactId(db, input.contactId);
  const id = Crypto.randomUUID();
  const now = new Date().toISOString();

  const contact = await db.getFirstAsync<{ name: string }>(
    'SELECT name FROM contacts WHERE id = ? AND deleted_at IS NULL',
    input.contactId
  );
  if (!contact) throw new Error('Choose an available contact for this reminder.');

  await db.withExclusiveTransactionAsync(async (transaction) => {
    if (!await transaction.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', input.contactId)) {
      throw new Error('Choose an available contact for this reminder.');
    }
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
    if (draftKey) await clearJournalDraft(transaction, draftKey);
  });

  signalSyncChange(db);
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
  const now = new Date().toISOString();
  let notificationId: string | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const reminder = await transaction.getFirstAsync<{ notification_id: string | null; completed_at: string | null }>(`
      SELECT r.notification_id, r.completed_at FROM reminders r JOIN contacts c ON c.id = r.contact_id
      WHERE r.id = ? AND r.completed_at IS NULL AND r.deleted_at IS NULL AND c.deleted_at IS NULL`, reminderId);
    if (!reminder) return;
    const remote = await transaction.getFirstAsync<{ record_json: string }>("SELECT record_json FROM sync_remote_entities WHERE entity_type = 'reminder' AND id = ?", reminderId);
    notificationId = reminder.notification_id;
    await transaction.runAsync(`
      UPDATE reminders
      SET completed_at = ?, updated_at = ?, sync_state = 'pending'
      WHERE id = ? AND completed_at IS NULL AND deleted_at IS NULL
    `, now, now, reminderId);
    await enqueueSyncIntent(transaction, 'reminder', reminderId, 'update', {
      completed_at: now,
    }, now, { revision: remote ? (JSON.parse(remote.record_json) as { revision: number }).revision : null,
      values: { completed_at: reminder.completed_at } });
  });
  signalSyncChange(db);
  return notificationId;
}

/** Commit the new time and its intent together before touching the OS scheduler. */
export async function snoozeReminder(db: SQLiteDatabase, shown: ReminderRecord, remindAt: Date): Promise<{
  reminder: ReminderRecord; previousNotificationId: string | null; changed: boolean;
}> {
  if (!Number.isFinite(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
    throw new Error('Choose a future reminder time.');
  }
  const nextTime = remindAt.toISOString(), now = new Date().toISOString();
  let result: { reminder: ReminderRecord; previousNotificationId: string | null; changed: boolean } | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await transaction.getFirstAsync<ReminderRecord>(`SELECT r.*, c.name AS contact_name
      FROM reminders r JOIN contacts c ON c.id = r.contact_id
      WHERE r.id = ? AND r.completed_at IS NULL AND r.deleted_at IS NULL AND c.deleted_at IS NULL`, shown.id);
    if (!current) throw new Error('This reminder is no longer open. Refresh your reminders.');
    if (current.remind_at !== shown.remind_at) throw new Error('This reminder time changed. Refresh it before choosing another time.');
    if (Date.parse(current.remind_at) === remindAt.getTime()) {
      result = { reminder: current, previousNotificationId: null, changed: false }; return;
    }
    const remote = await transaction.getFirstAsync<{ record_json: string }>(
      "SELECT record_json FROM sync_remote_entities WHERE entity_type = 'reminder' AND id = ?", current.id);
    await transaction.runAsync(`UPDATE reminders SET remind_at = ?, notification_id = NULL, updated_at = ?,
      sync_state = CASE WHEN EXISTS (SELECT 1 FROM sync_queue WHERE entity_type = 'reminder' AND entity_id = ?
        AND status = 'conflict') THEN 'conflict' ELSE 'pending' END WHERE id = ?`, nextTime, now, current.id, current.id);
    await enqueueSyncIntent(transaction, 'reminder', current.id, 'update', { remind_at: nextTime }, now,
      { revision: remote ? (JSON.parse(remote.record_json) as { revision: number }).revision : null,
        values: { remind_at: current.remind_at } });
    result = { reminder: { ...current, remind_at: nextTime, notification_id: null }, previousNotificationId: current.notification_id, changed: true };
  });
  if (result!.changed) signalSyncChange(db);
  return result!;
}

export async function saveReminderNotification(db: SQLiteDatabase, reminder: ReminderRecord, notificationId: string | null): Promise<boolean> {
  const result = await db.runAsync(`UPDATE reminders SET notification_id = ? WHERE id = ? AND remind_at = ?
    AND completed_at IS NULL AND deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM contacts WHERE contacts.id = reminders.contact_id AND deleted_at IS NULL)`,
    notificationId, reminder.id, reminder.remind_at);
  return result.changes > 0;
}
