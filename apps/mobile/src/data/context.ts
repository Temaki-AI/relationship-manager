import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { normalizeContextFields, type ContextEntity } from '../../../../packages/domain/src/relationship-context';
import type { SyncValue } from '../../../../packages/domain/src/sync';
import { childTable, remoteEntity, stagePlanCompletion } from './sync-entities';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
import { canonicalContactId } from './contact-aliases';
import { clearJournalDraft } from './journal-drafts';

export type ContextRecord = Record<string, SyncValue> & { id: string; contact_id: string; remote_revision: number | null };

export async function contextForEditing(db: SQLiteDatabase, entity: ContextEntity, id: string): Promise<ContextRecord | null> {
  return db.getFirstAsync<ContextRecord>(`SELECT item.*, CAST(json_extract(remote.record_json, '$.revision') AS INTEGER) AS remote_revision
    FROM ${childTable(entity)} item JOIN contacts parent ON parent.id = item.contact_id AND parent.deleted_at IS NULL
    LEFT JOIN sync_remote_entities remote ON remote.entity_type = ? AND remote.id = item.id WHERE item.id = ? AND item.deleted_at IS NULL`, entity, id);
}

export async function listContext(db: SQLiteDatabase, entity: ContextEntity, contactId: string, offset = 0): Promise<ContextRecord[]> {
  contactId = await canonicalContactId(db, contactId);
  const where = entity === 'relationship' ? '(item.contact_id = ? OR item.related_contact_id = ?)' : 'item.contact_id = ?';
  return db.getAllAsync<ContextRecord>(`SELECT item.*, ${entity === 'relationship'
    ? "CASE WHEN item.contact_id = ? THEN item.relationship_label ELSE item.reciprocal_label END AS display_label, CASE WHEN item.contact_id = ? THEN item.related_contact_id ELSE item.contact_id END AS other_contact_id,"
    : ''} ${entity === 'family' ? 'linked.name AS linked_name,' : entity === 'relationship' ? 'related.name AS related_name,' : ''}
    CAST(json_extract(remote.record_json, '$.revision') AS INTEGER) AS remote_revision
    FROM ${childTable(entity)} item LEFT JOIN sync_remote_entities remote ON remote.entity_type = ? AND remote.id = item.id
    ${entity === 'family' ? 'LEFT JOIN contacts linked ON linked.id = item.linked_contact_id'
      : entity === 'relationship' ? 'LEFT JOIN contacts related ON related.id = CASE WHEN item.contact_id = ? THEN item.related_contact_id ELSE item.contact_id END' : ''}
    WHERE ${where} AND item.deleted_at IS NULL ORDER BY ${entity === 'plan' ? 'item.completed_at IS NOT NULL, item.planned_date, ' : ''}item.id LIMIT 50 OFFSET ?`,
    ...(entity === 'relationship' ? [contactId, contactId] : []), entity, ...(entity === 'relationship' ? [contactId] : []), contactId, ...(entity === 'relationship' ? [contactId] : []), offset);
}

export async function listAgendaPlans(db: SQLiteDatabase, offset = 0) {
  return db.getAllAsync<ContextRecord & { contact_name: string }>(`SELECT p.*, c.name AS contact_name FROM plans p JOIN contacts c ON c.id = p.contact_id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.completed_at IS NULL ORDER BY p.planned_date, p.id LIMIT 50 OFFSET ?`, offset);
}

async function validateReferences(db: SQLiteDatabase, entity: ContextEntity, contactId: string, fields: Record<string, SyncValue>, existing?: ContextRecord) {
  if (!await db.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', contactId)) throw new Error('This person is no longer available.');
  const related = entity === 'family' ? fields.linked_contact_id : entity === 'relationship' ? fields.related_contact_id : null;
  if (related != null) {
    if (related === contactId) throw new Error('Choose a different person to connect.');
    const profile = await db.getFirstAsync<{ birthday: string | null }>('SELECT birthday FROM contacts WHERE id = ? AND deleted_at IS NULL', related);
    if (!profile) throw new Error('The linked person is no longer available.');
    if (entity === 'family' && existing?.linked_contact_id !== related && fields.birthday && fields.birthday !== profile.birthday) throw new Error('Set the same birthday on the linked profile before connecting these records.');
    const duplicate = await db.getFirstAsync(`SELECT id FROM ${childTable(entity)} WHERE deleted_at IS NULL AND id <> ? AND ${entity === 'family'
      ? 'contact_id = ? AND linked_contact_id = ?' : '((contact_id = ? AND related_contact_id = ?) OR (related_contact_id = ? AND contact_id = ?))'}`,
      existing?.id ?? '', contactId, related, ...(entity === 'relationship' ? [contactId, related] : []));
    if (duplicate) throw new Error('These people already have this connection.');
  }
}

export async function createContext(db: SQLiteDatabase, entity: ContextEntity, contactId: string, input: Record<string, unknown>, draftKey?: string) {
  const fields = normalizeContextFields(entity, input), id = Crypto.randomUUID(), now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (tx) => {
    contactId = await canonicalContactId(tx, contactId);
    for (const key of ['linked_contact_id', 'related_contact_id']) if (typeof fields[key] === 'string') fields[key] = await canonicalContactId(tx, fields[key]);
    await validateReferences(tx, entity, contactId, fields);
    const columns = Object.keys(fields);
    await tx.runAsync(`INSERT INTO ${childTable(entity)} (id, contact_id, ${columns.join(', ')}, created_at, updated_at, sync_state)
      VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?, 'pending')`, id, contactId, ...Object.values(fields), now, now);
    await enqueueSyncIntent(tx, entity, id, 'create', { contact_id: contactId, ...fields }, now);
    if (draftKey) await clearJournalDraft(tx, draftKey);
  });
  signalSyncChange(db); return id;
}

export async function updateContext(db: SQLiteDatabase, entity: ContextEntity, original: ContextRecord, input: Record<string, unknown>, draftKey?: string) {
  const fields = normalizeContextFields(entity, input);
  if (entity === 'relationship' && fields.related_contact_id !== original.related_contact_id) throw new Error('Create a separate relationship to connect a different person.');
  const changed = Object.keys(fields).filter((key) => fields[key] !== original[key]);
  const patch = Object.fromEntries(changed.map((key) => [key, fields[key]])), now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (tx) => {
    if (!await contextForEditing(tx, entity, original.id)) throw new Error('This item is no longer available. Your form is still here.');
    if (draftKey) await clearJournalDraft(tx, draftKey);
    if (!changed.length) return;
    const parent = await canonicalContactId(tx, original.contact_id);
    const references = { ...fields };
    for (const key of ['linked_contact_id', 'related_contact_id']) if (typeof references[key] === 'string') references[key] = await canonicalContactId(tx, references[key]);
    await validateReferences(tx, entity, parent, references, original);
    await tx.runAsync(`UPDATE ${childTable(entity)} SET ${changed.map((key) => `${key} = ?`).join(', ')}, updated_at = ?,
      sync_state = CASE WHEN EXISTS (SELECT 1 FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status = 'conflict') THEN 'conflict' ELSE 'pending' END WHERE id = ?`,
      ...changed.map((key) => fields[key]), now, entity, original.id, original.id);
    await enqueueSyncIntent(tx, entity, original.id, 'update', patch, now, { revision: original.remote_revision,
      values: Object.fromEntries(changed.map((key) => [key, original[key]])) });
  });
  signalSyncChange(db);
}

export async function completePlan(db: SQLiteDatabase, id: string) {
  let historyId: string | null = null;
  await db.withExclusiveTransactionAsync(async (tx) => {
    const plan = await contextForEditing(tx, 'plan', id);
    if (!plan || plan.completed_at !== null) return;
    const now = new Date().toISOString();
    await tx.runAsync(`UPDATE plans SET completed_at = ?, updated_at = ?, sync_state = CASE WHEN EXISTS
      (SELECT 1 FROM sync_queue WHERE entity_type = 'plan' AND entity_id = ? AND status = 'conflict') THEN 'conflict' ELSE 'pending' END
      WHERE id = ? AND completed_at IS NULL`, now, now, id, id);
    historyId = await stagePlanCompletion(tx, plan, now, plan.remote_revision);
  });
  signalSyncChange(db); return historyId;
}

export async function deleteContext(db: SQLiteDatabase, entity: ContextEntity, id: string) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    const current = await contextForEditing(tx, entity, id); if (!current) return;
    const remote = await remoteEntity(tx, entity, id), now = new Date().toISOString();
    await tx.runAsync(`UPDATE ${childTable(entity)} SET deleted_at = ?, updated_at = ?, sync_state = 'pending' WHERE id = ?`, now, now, id);
    await enqueueSyncIntent(tx, entity, id, 'delete', {}, now, { revision: remote?.revision ?? null, values: {} });
  });
  signalSyncChange(db);
}
