import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  normalizeContactDraft,
  type ContactDraft,
  type ContactRecord,
} from '@/domain/contact';
import { enqueueSyncIntent } from './sync-queue';

export type InteractionType = 'call' | 'message' | 'meetup' | 'email';

export type InteractionRecord = {
  id: string;
  contact_id: string;
  type: InteractionType;
  occurred_at: string;
  summary: string | null;
  notes: string | null;
};

export type DashboardSnapshot = {
  contactCount: number;
  attentionCount: number;
  touchesThisWeek: number;
};

function searchPattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

export async function listContacts(db: SQLiteDatabase, search = ''): Promise<ContactRecord[]> {
  if (!search.trim()) {
    return db.getAllAsync<ContactRecord>(`
      SELECT * FROM contacts
      WHERE deleted_at IS NULL
      ORDER BY name COLLATE NOCASE, id
      LIMIT 500
    `);
  }

  const pattern = searchPattern(search);
  return db.getAllAsync<ContactRecord>(`
    SELECT * FROM contacts
    WHERE deleted_at IS NULL
      AND (
        name LIKE ? ESCAPE '\\'
        OR email LIKE ? ESCAPE '\\'
        OR phone LIKE ? ESCAPE '\\'
        OR notes LIKE ? ESCAPE '\\'
      )
    ORDER BY name COLLATE NOCASE, id
    LIMIT 500
  `, pattern, pattern, pattern, pattern);
}

export async function getContact(db: SQLiteDatabase, id: string): Promise<ContactRecord | null> {
  return db.getFirstAsync<ContactRecord>(
    'SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL',
    id
  );
}

export async function createContact(
  db: SQLiteDatabase,
  draft: ContactDraft
): Promise<ContactRecord> {
  const input = normalizeContactDraft(draft);
  const id = Crypto.randomUUID();
  const now = new Date().toISOString();

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(`
      INSERT INTO contacts (
        id, device_contact_id, name, email, phone, notes, contact_frequency,
        created_at, updated_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    id,
    input.deviceContactId,
    input.name,
    input.email,
    input.phone,
    input.notes,
    input.contactFrequency,
    now,
    now);
    await enqueueSyncIntent(transaction, 'contact', id, 'create', input, now);
  });

  const contact = await getContact(db, id);
  if (!contact) throw new Error('The contact was created but could not be reloaded.');
  return contact;
}

export async function importDeviceContact(
  db: SQLiteDatabase,
  draft: ContactDraft & { deviceContactId: string }
): Promise<{ contact: ContactRecord; created: boolean }> {
  const input = normalizeContactDraft(draft);
  const existing = await db.getFirstAsync<ContactRecord>(`
    SELECT * FROM contacts
    WHERE deleted_at IS NULL
      AND (
        device_contact_id = ?
        OR (? IS NOT NULL AND lower(email) = lower(?))
        OR (? IS NOT NULL AND phone = ?)
      )
    ORDER BY created_at, id
    LIMIT 1
  `,
  input.deviceContactId,
  input.email,
  input.email,
  input.phone,
  input.phone);

  if (existing) return { contact: existing, created: false };
  return { contact: await createContact(db, draft), created: true };
}

export async function listContactInteractions(
  db: SQLiteDatabase,
  contactId: string
): Promise<InteractionRecord[]> {
  return db.getAllAsync<InteractionRecord>(`
    SELECT id, contact_id, type, occurred_at, summary, notes
    FROM interactions
    WHERE contact_id = ? AND deleted_at IS NULL
    ORDER BY occurred_at DESC, id DESC
    LIMIT 20
  `, contactId);
}

export async function logInteraction(
  db: SQLiteDatabase,
  contactId: string,
  type: InteractionType
): Promise<InteractionRecord> {
  const contact = await getContact(db, contactId);
  if (!contact) throw new Error('This contact is no longer available.');

  const id = Crypto.randomUUID();
  const now = new Date().toISOString();
  const summary = type === 'meetup' ? 'Spent time together' : `Logged a ${type}`;

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(`
      INSERT INTO interactions (
        id, contact_id, type, occurred_at, summary, created_at, updated_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `, id, contactId, type, now, summary, now, now);
    await transaction.runAsync(`
      UPDATE contacts
      SET last_contacted = ?, updated_at = ?, sync_state = 'pending'
      WHERE id = ? AND deleted_at IS NULL
    `, now, now, contactId);
    await enqueueSyncIntent(transaction, 'interaction', id, 'create', {
      contactId,
      type,
      occurredAt: now,
      summary,
    }, now);
    await enqueueSyncIntent(transaction, 'contact', contactId, 'update', {
      lastContacted: now,
    }, now);
  });

  return { id, contact_id: contactId, type, occurred_at: now, summary, notes: null };
}

export async function getDashboardSnapshot(db: SQLiteDatabase): Promise<DashboardSnapshot> {
  const [contacts, attention, touches] = await Promise.all([
    db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) count FROM contacts WHERE deleted_at IS NULL'
    ),
    db.getFirstAsync<{ count: number }>(`
      SELECT COUNT(*) count
      FROM contacts
      WHERE deleted_at IS NULL
        AND (
          last_contacted IS NULL
          OR julianday('now') - julianday(last_contacted) >= contact_frequency
        )
    `),
    db.getFirstAsync<{ count: number }>(`
      SELECT COUNT(*) count
      FROM interactions
      WHERE deleted_at IS NULL
        AND julianday(occurred_at) >= julianday('now', '-7 days')
    `),
  ]);

  return {
    contactCount: contacts?.count ?? 0,
    attentionCount: attention?.count ?? 0,
    touchesThisWeek: touches?.count ?? 0,
  };
}
