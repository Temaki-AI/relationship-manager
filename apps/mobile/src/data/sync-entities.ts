import type { SQLiteDatabase } from 'expo-sqlite';
import { readSyncRecord } from '../../../../packages/domain/src/sync-client';
import { readSyncV3Record } from '../../../../packages/domain/src/sync-v3-client';
import type { SyncV3Entity as SyncEntity, SyncV3EntityRecord as SyncEntityRecord } from '../../../../packages/domain/src/sync-v3';
import type { SyncValue } from '../../../../packages/domain/src/sync';
import { enqueueSyncIntent } from './sync-queue';

export type QueueRow = {
  id: string; entity_type: SyncEntity; entity_id: string; operation: 'create' | 'update' | 'delete'; payload: string;
  epoch: string | null; base_revision: number | null; base_payload: string | null;
  request_json: string | null; status: 'pending' | 'conflict'; response_json: string | null; last_error_code: string | null;
};
export const CHILD_ENTITIES = ['family', 'interaction', 'plan', 'relationship', 'reminder'] as const;
export type ChildEntity = typeof CHILD_ENTITIES[number];
const tables = { family: 'contact_children', interaction: 'interactions', plan: 'plans', relationship: 'contact_relationships', reminder: 'reminders' } as const;
export function childTable(entity: ChildEntity) { return tables[entity]; }
export const CHILD_FIELDS = {
  interaction: ['date', 'occurred_at', 'type', 'summary', 'notes'],
  reminder: ['title', 'notes', 'remind_at', 'completed_at'],
  plan: ['type', 'planned_date', 'summary', 'notes', 'completed_at'],
  family: ['name', 'birthday', 'linked_contact_id'],
  relationship: ['related_contact_id', 'relationship_label', 'reciprocal_label'],
} as const;
export function childReferences(entity: ChildEntity, data: Record<string, unknown>) {
  return [data.contact_id, ...(entity === 'family' ? [data.linked_contact_id] : entity === 'relationship' ? [data.related_contact_id] : [])]
    .filter((id): id is string => typeof id === 'string');
}

export function childPayload(row: Pick<QueueRow, 'entity_type' | 'operation' | 'payload'>): Record<string, unknown> {
  const source = JSON.parse(row.payload) as Record<string, unknown>;
  const mapped = Object.fromEntries(Object.entries(source).map(([key, value]) => [{ contactId: 'contact_id', occurredAt: 'occurred_at',
    remindAt: 'remind_at', completedAt: 'completed_at', plannedDate: 'planned_date', linkedContactId: 'linked_contact_id',
    relatedContactId: 'related_contact_id', relationshipLabel: 'relationship_label', reciprocalLabel: 'reciprocal_label' }[key] ?? key, value]));
  if (row.operation !== 'create') return mapped;
  if (row.entity_type === 'interaction') return { contact_id: mapped.contact_id, date: mapped.date ?? String(mapped.occurred_at).slice(0, 10),
    occurred_at: mapped.occurred_at ?? null, type: mapped.type, summary: mapped.summary ?? null, notes: mapped.notes ?? null };
  if (row.entity_type === 'reminder') return { contact_id: mapped.contact_id, title: mapped.title, remind_at: mapped.remind_at, completed_at: mapped.completed_at ?? null, notes: mapped.notes ?? null };
  if (row.entity_type === 'plan') return { contact_id: mapped.contact_id, type: mapped.type, planned_date: mapped.planned_date,
    summary: mapped.summary ?? null, notes: mapped.notes ?? null, completed_at: mapped.completed_at ?? null };
  if (row.entity_type === 'family') return { contact_id: mapped.contact_id, name: mapped.name, birthday: mapped.birthday ?? null, linked_contact_id: mapped.linked_contact_id ?? null };
  return { contact_id: mapped.contact_id, related_contact_id: mapped.related_contact_id,
    relationship_label: mapped.relationship_label, reciprocal_label: mapped.reciprocal_label };
}

export async function remoteEntity(db: SQLiteDatabase, entity: SyncEntity, id: string): Promise<SyncEntityRecord | null> {
  if (entity === 'contact') {
    const raw = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_contacts WHERE id = ?', id);
    return raw ? { ...readSyncRecord(JSON.parse(raw.record_json)), entity } : null;
  }
  const raw = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_entities WHERE entity_type = ? AND id = ?', entity, id);
  return raw ? readSyncV3Record(JSON.parse(raw.record_json)) : null;
}

/** Completion's operation UUID also identifies the server-created history record. */
export async function stagePlanCompletion(db: SQLiteDatabase, plan: Record<string, SyncValue>, completedAt: string, revision: number | null) {
  const operationId = await enqueueSyncIntent(db, 'plan', String(plan.id), 'update', { completed_at: completedAt }, completedAt,
    { revision, values: { completed_at: null } });
  await db.runAsync(`INSERT INTO interactions (id, contact_id, source_plan_id, type, date, occurred_at, summary, notes,
    created_at, updated_at, sync_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    operationId, plan.contact_id, plan.id, plan.type, completedAt.slice(0, 10), completedAt, plan.summary, plan.notes, completedAt, completedAt);
  await db.runAsync(`UPDATE contacts SET last_contacted = CASE WHEN last_contacted IS NULL OR last_contacted < ? THEN ? ELSE last_contacted END,
    updated_at = ? WHERE id = ?`, completedAt.slice(0, 10), completedAt.slice(0, 10), completedAt, plan.contact_id);
  return operationId;
}

export async function discardPlanCompletionDrafts(db: SQLiteDatabase, planId: string) {
  await db.runAsync(`UPDATE interactions SET deleted_at = ?, sync_state = 'synced' WHERE source_plan_id = ?
    AND remote_id IS NULL AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'interaction' AND q.entity_id = interactions.id)`, new Date().toISOString(), planId);
}

export async function applyRemoteChild(db: SQLiteDatabase, record: SyncEntityRecord & { entity: ChildEntity }) {
  await db.runAsync(`INSERT INTO sync_remote_entities (entity_type, id, record_json) VALUES (?, ?, ?)
    ON CONFLICT(entity_type, id) DO UPDATE SET record_json = excluded.record_json`, record.entity, record.id, JSON.stringify(record));
  const table = childTable(record.entity);
  const intents = await db.getAllAsync<QueueRow>('SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ? ORDER BY rowid', record.entity, record.id);
  const local = await db.getFirstAsync<Record<string, SyncValue>>(`SELECT * FROM ${table} WHERE id = ?`, record.id);
  if (record.deleted) {
    if (intents.length) {
      await db.runAsync(`UPDATE sync_queue SET
        status = CASE WHEN request_json IS NOT NULL AND status = 'pending' THEN status ELSE 'conflict' END,
        last_error_code = CASE WHEN last_error_code IN ('epoch_changed', 'merged_self_link') OR request_json IS NOT NULL AND status = 'pending'
          THEN last_error_code ELSE 'remote_deleted' END WHERE entity_type = ? AND entity_id = ?`, record.entity, record.id);
      await db.runAsync(`UPDATE ${table} SET sync_state = 'conflict' WHERE id = ?`, record.id);
    } else await db.runAsync(`UPDATE ${table} SET deleted_at = ?, sync_state = 'synced' WHERE id = ?`, new Date().toISOString(), record.id);
    if (record.entity === 'plan' && !intents.length) await discardPlanCompletionDrafts(db, record.id);
    return;
  }
  const protectedFields = new Set(intents.flatMap((row) => row.operation === 'delete' ? ['deleted_at'] : Object.keys(childPayload(row))));
  const data = record.data!;
  const value = (key: string) => protectedFields.has(key) && local ? local[key] : data[key];
  for (const id of childReferences(record.entity, { contact_id: value('contact_id'), linked_contact_id: value('linked_contact_id'), related_contact_id: value('related_contact_id') })) {
    if (!await db.getFirstAsync('SELECT id FROM contacts WHERE id = ?', id)) throw new Error('A download references a missing person. Keep offline data and restart sync.');
  }
  const state = intents.some((row) => row.status === 'conflict') ? 'conflict' : intents.length ? 'pending' : 'synced';
  const columns = ['contact_id', ...CHILD_FIELDS[record.entity], 'created_at', 'updated_at', 'deleted_at', 'sync_state'];
  const values = [value('contact_id'), ...CHILD_FIELDS[record.entity].map(value), local?.created_at ?? data.created_at,
    intents.length && local ? local.updated_at : new Date().toISOString(), protectedFields.has('deleted_at') ? local?.deleted_at ?? null : null, state];
  await db.runAsync(`INSERT INTO ${table} (id, remote_id, ${columns.join(', ')}) VALUES (?, ?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET remote_id = excluded.remote_id, ${columns.filter((key) => key !== 'created_at').map((key) => `${key} = excluded.${key}`).join(', ')}`,
  record.id, record.legacyId, ...values);
  if (record.entity === 'plan' && !intents.length) await db.runAsync(`UPDATE interactions SET deleted_at = ?, sync_state = 'synced'
    WHERE source_plan_id = ? AND remote_id IS NULL AND occurred_at IS NOT ?`, new Date().toISOString(), record.id, data.completed_at);
}

export async function pendingChildren(db: SQLiteDatabase, contactId: string) {
  return db.getAllAsync<QueueRow>(`SELECT q.* FROM sync_queue q WHERE ${CHILD_ENTITIES.map((entity) => `(q.entity_type = '${entity}' AND q.entity_id IN
    (SELECT id FROM ${childTable(entity)} WHERE contact_id = ? ${entity === 'relationship' ? 'OR related_contact_id = ?'
      : entity === 'family' ? "OR linked_contact_id = ? AND (q.operation = 'create' OR json_type(q.payload, '$.linked_contact_id') IS NOT NULL)" : ''}))`).join(' OR ')} ORDER BY q.rowid`,
    ...CHILD_ENTITIES.flatMap((entity) => entity === 'family' || entity === 'relationship' ? [contactId, contactId] : [contactId]));
}
