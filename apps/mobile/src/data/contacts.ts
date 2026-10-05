import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  normalizeContactDraft,
  type ContactDraft,
  type ContactRecord,
} from '@/domain/contact';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
import { canonicalContactId } from './contact-aliases';
import { replacePrimaryContactMethods } from '../../../../packages/domain/src/contact-methods';
import { clearContactDraft } from './contact-drafts';

export type InteractionType = 'call' | 'message' | 'meetup' | 'email';

export type InteractionRecord = {
  id: string;
  contact_id: string;
  type: InteractionType;
  date: string;
  occurred_at: string | null;
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

export const PEOPLE_PAGE_SIZE = 50;

export async function listContactPage(db: SQLiteDatabase, search = '', page = 0): Promise<{ contacts: ContactRecord[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * PEOPLE_PAGE_SIZE)) {
    throw new Error('Choose an available people page.');
  }
  const pattern = searchPattern(search);
  const rows = await db.getAllAsync<ContactRecord>(`
    SELECT * FROM contacts
    WHERE deleted_at IS NULL AND (
      name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(contact_methods) WHERE json_extract(value, '$.value') LIKE ? ESCAPE '\\' OR json_extract(value, '$.label') LIKE ? ESCAPE '\\')
    )
    ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?
  `, pattern, pattern, pattern, pattern, pattern, pattern, PEOPLE_PAGE_SIZE + 1, page * PEOPLE_PAGE_SIZE);
  return { contacts: rows.slice(0, PEOPLE_PAGE_SIZE), hasMore: rows.length > PEOPLE_PAGE_SIZE };
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
        OR EXISTS (SELECT 1 FROM json_each(contact_methods) WHERE json_extract(value, '$.value') LIKE ? ESCAPE '\\' OR json_extract(value, '$.label') LIKE ? ESCAPE '\\')
      )
    ORDER BY name COLLATE NOCASE, id
    LIMIT 500
  `, pattern, pattern, pattern, pattern, pattern, pattern);
}

export async function getContact(db: SQLiteDatabase, id: string): Promise<ContactRecord | null> {
  return db.getFirstAsync<ContactRecord>(
    'SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL',
    await canonicalContactId(db, id)
  );
}

export type ContactEditBase = ContactRecord & { remote_revision: number | null };
export type ContactFieldEditBase = Pick<ContactEditBase, 'id' | 'name' | 'email' | 'phone' | 'notes' | 'contact_frequency' | 'remote_revision'>;
export async function getContactForEditing(db: SQLiteDatabase, id: string): Promise<ContactEditBase | null> {
  return db.getFirstAsync<ContactEditBase>(`SELECT c.*, CAST(json_extract(r.record_json, '$.revision') AS INTEGER) AS remote_revision
    FROM contacts c LEFT JOIN sync_remote_contacts r ON r.id = c.id WHERE c.id = ? AND c.deleted_at IS NULL`, await canonicalContactId(db, id));
}

export async function updateContact(db: SQLiteDatabase, original: ContactFieldEditBase, draft: ContactDraft, draftKey?: string): Promise<void> {
  const input = normalizeContactDraft(draft);
  const values = { name: input.name, email: input.email, phone: input.phone, notes: input.notes, contact_frequency: input.contactFrequency };
  const fields = (Object.keys(values) as (keyof typeof values)[]).filter((field) => values[field] !== original[field]);
  const patch = Object.fromEntries(fields.map((field) => [field, values[field]]));
  const base = Object.fromEntries(fields.map((field) => [field, original[field]]));
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await getContact(transaction, original.id);
    if (!current) throw new Error('This person is no longer available. Your form is still here; review the cloud changes before saving.');
    if (draftKey) await clearContactDraft(transaction, draftKey);
    if (!fields.length) return;
    const conflict = await transaction.getFirstAsync<{ id: string }>("SELECT id FROM sync_queue WHERE entity_type = 'contact' AND entity_id IN (?, ?) AND status = 'conflict' LIMIT 1", original.id, current.id);
    await transaction.runAsync(`UPDATE contacts SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ?, sync_state = ? WHERE id = ?`,
      ...fields.map((field) => values[field]), now, conflict ? 'conflict' : 'pending', current.id);
    await enqueueSyncIntent(transaction, 'contact', original.id, 'update', patch, now,
      { revision: original.remote_revision, values: base });
    if (fields.includes('email') || fields.includes('phone')) {
      const local = await transaction.getFirstAsync<{ contact_methods: string }>('SELECT contact_methods FROM contacts WHERE id = ?', current.id);
      const methods = replacePrimaryContactMethods(local?.contact_methods ?? '[]', Object.fromEntries(fields.filter((field) => field === 'email' || field === 'phone').map((field) => [field, values[field]])), Crypto.randomUUID);
      await transaction.runAsync('UPDATE contacts SET contact_methods = ? WHERE id = ?', methods, current.id);
    }
  });
  signalSyncChange(db);
}

export async function createContact(
  db: SQLiteDatabase,
  draft: ContactDraft,
  draftKey?: string
): Promise<ContactRecord> {
  const input = normalizeContactDraft(draft);
  const id = Crypto.randomUUID();
  const now = new Date().toISOString();
  const methods = replacePrimaryContactMethods('[]', { email: input.email, phone: input.phone }, Crypto.randomUUID);
  let contact: ContactRecord | null = null;

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(`
      INSERT INTO contacts (
        id, device_contact_id, name, email, phone, notes, contact_frequency,
        created_at, updated_at, contact_methods, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    id,
    input.deviceContactId,
    input.name,
    input.email,
    input.phone,
    input.notes,
    input.contactFrequency,
    now,
    now, methods);
    await enqueueSyncIntent(transaction, 'contact', id, 'create', { ...input, contact_methods: methods }, now);
    if (draftKey) await clearContactDraft(transaction, draftKey);
    contact = await getContact(transaction, id);
    if (!contact) throw new Error('The contact could not be reloaded. Your form is still here.');
  });

  signalSyncChange(db);
  return contact!;
}

export type InteractionCursor = { contactId: string; date: string; occurredAt: string; id: string };
export const INTERACTION_PAGE_SIZE = 20;

export async function listContactInteractionPage(db: SQLiteDatabase, contactId: string, cursor: InteractionCursor | null = null)
  : Promise<{ interactions: InteractionRecord[]; nextCursor: InteractionCursor | null }> {
  contactId = await canonicalContactId(db, contactId);
  if (cursor && (cursor.contactId !== contactId || !cursor.id || typeof cursor.date !== 'string' || typeof cursor.occurredAt !== 'string')) {
    throw new Error('Refresh this relationship timeline before continuing.');
  }
  const rows = await db.getAllAsync<InteractionRecord>(`
    SELECT id, contact_id, type, date, occurred_at, summary, notes FROM interactions
    WHERE contact_id = ? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM contacts WHERE id = interactions.contact_id AND deleted_at IS NULL)
      ${cursor ? "AND (date, COALESCE(occurred_at, ''), id) < (?, ?, ?)" : ''}
    ORDER BY date DESC, COALESCE(occurred_at, '') DESC, id DESC LIMIT ?
  `, contactId, ...(cursor ? [cursor.date, cursor.occurredAt, cursor.id] : []), INTERACTION_PAGE_SIZE + 1);
  const interactions = rows.slice(0, INTERACTION_PAGE_SIZE), last = interactions.at(-1);
  return { interactions, nextCursor: rows.length > INTERACTION_PAGE_SIZE && last
    ? { contactId, date: last.date, occurredAt: last.occurred_at ?? '', id: last.id } : null };
}

export async function listContactInteractions(
  db: SQLiteDatabase,
  contactId: string
): Promise<InteractionRecord[]> {
  return (await listContactInteractionPage(db, contactId)).interactions;
}

export async function logInteraction(
  db: SQLiteDatabase,
  contactId: string,
  type: InteractionType
): Promise<InteractionRecord> {
  const contact = await getContact(db, contactId);
  if (!contact) throw new Error('This contact is no longer available.');
  contactId = contact.id;

  const id = Crypto.randomUUID();
  const now = new Date().toISOString();
  const summary = type === 'meetup' ? 'Spent time together' : `Logged a ${type}`;

  await db.withExclusiveTransactionAsync(async (transaction) => {
    const original = await transaction.getFirstAsync<{ last_contacted: string | null }>('SELECT last_contacted FROM contacts WHERE id = ? AND deleted_at IS NULL', contactId);
    if (!original) throw new Error('This contact is no longer available.');
    const lastContacted = now.slice(0, 10);
    await transaction.runAsync(`
      INSERT INTO interactions (
        id, contact_id, type, date, occurred_at, summary, created_at, updated_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, id, contactId, type, lastContacted, now, summary, now, now);
    await transaction.runAsync(`
      UPDATE contacts
      SET last_contacted = ?, updated_at = ?, sync_state = 'pending'
      WHERE id = ? AND deleted_at IS NULL
    `, lastContacted, now, contactId);
    await enqueueSyncIntent(transaction, 'interaction', id, 'create', {
      contactId,
      type,
      occurredAt: now,
      summary,
    }, now);
  });

  signalSyncChange(db);
  return { id, contact_id: contactId, type, date: now.slice(0, 10), occurred_at: now, summary, notes: null };
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
        AND julianday(COALESCE(occurred_at, date)) >= julianday('now', '-7 days')
    `),
  ]);

  return {
    contactCount: contacts?.count ?? 0,
    attentionCount: attention?.count ?? 0,
    touchesThisWeek: touches?.count ?? 0,
  };
}
