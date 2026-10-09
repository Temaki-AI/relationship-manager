import { isSyncSequence, isSyncUuid, MAX_SYNC_RECORD_BYTES, SYNC_PAGE_SIZE, type SyncCursor } from './sync.ts';
import { readSyncCursor, readCanonicalContactRecord } from './sync-client.ts';
import { readSyncV2Record } from './sync-v2-client.ts';
import { SYNC_V2_ENTITIES } from './sync-v2.ts';
import { SYNC_V3_ENTITIES, type SyncV3Entity, type SyncV3EntityRecord, type SyncV3BootstrapPosition, type SyncV3MutationResult } from './sync-v3.ts';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('The server returned an invalid sync response. Keep offline data and retry.'); }
function isEntity(value: unknown): value is SyncV3Entity { return (SYNC_V3_ENTITIES as readonly unknown[]).includes(value); }
function dateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && dateOnly(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= limit; }
function optionalText(value: unknown) { return value === null || typeof value === 'string'; }
function position(record: SyncV3EntityRecord) { return `${record.entity}:${record.id}`; }

export function readSyncV3Record(value: unknown): SyncV3EntityRecord {
  if (!object(value) || !isEntity(value.entity)) return invalid();
  if ((SYNC_V2_ENTITIES as readonly unknown[]).includes(value.entity)) return readSyncV2Record(value);
  if (!isSyncUuid(value.id) || !isSyncSequence(value.legacyId) || value.legacyId < 1
    || !isSyncSequence(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean'
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SYNC_RECORD_BYTES) return invalid();
  if (value.deleted) { if (value.data !== null) return invalid(); }
  else {
    const data = value.data;
    if (!object(data) || !isSyncUuid(data.contact_id) || typeof data.created_at !== 'string'
      || !Number.isFinite(Date.parse(data.created_at))
      || Object.values(data).some((item) => !(item === null || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)))) return invalid();
    if (value.entity === 'family') {
      if (!text(data.name, 200) || !(data.birthday === null || dateOnly(data.birthday))
        || !(data.linked_contact_id === null || isSyncUuid(data.linked_contact_id) && data.linked_contact_id !== data.contact_id)
        || typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at))) return invalid();
    } else if (value.entity === 'relationship') {
      if (!isSyncUuid(data.related_contact_id) || data.related_contact_id === data.contact_id
        || !text(data.relationship_label, 80) || !text(data.reciprocal_label, 80)) return invalid();
    } else if (!dateOnly(data.planned_date) || !['call', 'message', 'meetup', 'email'].includes(String(data.type))
      || !optionalText(data.summary) || !optionalText(data.notes)
      || !(data.completed_at === null || timestamp(data.completed_at))) return invalid();
  }
  return value as SyncV3EntityRecord;
}

export function readBootstrapV3(value: unknown) {
  if (!object(value) || value.version !== 3 || !Array.isArray(value.entities) || value.entities.length !== SYNC_V3_ENTITIES.length
    || value.entities.some((entity, index) => entity !== SYNC_V3_ENTITIES[index]) || !Array.isArray(value.records)
    || value.records.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor), records = value.records.map(readSyncV3Record);
  if (records.some((record, index) => record.deleted || index > 0 && position(record) <= position(records[index - 1]))) return invalid();
  let next: SyncV3BootstrapPosition | null = null;
  if (value.next !== null) {
    const current = readSyncCursor(value.next), last = records.at(-1);
    if (!object(value.next) || !isSyncUuid(value.next.after) || !isEntity(value.next.entity)
      || current.epoch !== cursor.epoch || current.sequence !== cursor.sequence
      || !last || last.id !== value.next.after || last.entity !== value.next.entity) return invalid();
    next = { ...current, after: value.next.after, entity: value.next.entity };
  }
  return { cursor, records, next };
}

export function readPullV3(value: unknown, previous: SyncCursor) {
  if (!object(value) || value.version !== 3 || typeof value.more !== 'boolean'
    || !Array.isArray(value.changes) || value.changes.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor);
  if (cursor.epoch !== previous.epoch || cursor.sequence < previous.sequence) return invalid();
  let sequence = previous.sequence;
  const records = value.changes.map((change) => {
    if (!object(change) || !isEntity(change.entity) || !isSyncSequence(change.sequence)
      || change.sequence <= sequence || change.sequence > cursor.sequence) return invalid();
    const record = readSyncV3Record(change.record);
    if (record.entity !== change.entity) return invalid();
    sequence = change.sequence;
    return record;
  });
  if (value.more && (!records.length || sequence !== cursor.sequence)) return invalid();
  return { cursor, records, more: value.more };
}

export function readPushResultV3(value: unknown, operationId: string, entity: SyncV3Entity, entityId: string): SyncV3MutationResult {
  if (!object(value) || value.version !== 3 || typeof value.replayed !== 'boolean' || !object(value.result)
    || value.result.operationId !== operationId || !['applied', 'conflict'].includes(String(value.result.status))) return invalid();
  const record = value.result.record === null ? null : readSyncV3Record(value.result.record);
  if (record && (record.entity !== entity || record.id !== entityId) || value.result.status === 'applied' && !record) return invalid();
  const canonicalRecord = readCanonicalContactRecord(value.result.canonicalRecord, record);
  if (canonicalRecord && (entity !== 'contact' || (canonicalRecord as SyncV3EntityRecord).entity !== 'contact')) return invalid();
  return { operationId, status: value.result.status as SyncV3MutationResult['status'], record,
    ...(canonicalRecord ? { canonicalRecord: { ...canonicalRecord, entity: 'contact' as const } } : {}) };
}
