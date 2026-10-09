import { isSyncSequence, isSyncUuid, MAX_SYNC_RECORD_BYTES, SYNC_PAGE_SIZE, type SyncCursor } from './sync.ts';
import { readSyncCursor, readSyncRecord, readCanonicalContactRecord } from './sync-client.ts';
import { SYNC_V2_ENTITIES, type SyncEntity, type SyncEntityRecord, type SyncV2BootstrapPosition, type SyncV2MutationResult } from './sync-v2.ts';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('The server returned an invalid sync response. Keep offline data and retry.'); }
function isEntity(value: unknown): value is SyncEntity { return (SYNC_V2_ENTITIES as readonly unknown[]).includes(value); }
function dateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && dateOnly(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function position(record: SyncEntityRecord) { return `${record.entity}:${record.id}`; }

export function readSyncV2Record(value: unknown): SyncEntityRecord {
  if (!object(value) || !isEntity(value.entity)) return invalid();
  if (value.entity === 'contact') return { ...readSyncRecord(value), entity: 'contact' };
  if (!isSyncUuid(value.id) || !isSyncSequence(value.legacyId) || value.legacyId < 1
    || !isSyncSequence(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean') return invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SYNC_RECORD_BYTES) return invalid();
  if (value.deleted) { if (value.data !== null) return invalid(); }
  else {
    const data = value.data;
    if (!object(data) || !isSyncUuid(data.contact_id) || typeof data.created_at !== 'string'
      || !Number.isFinite(Date.parse(data.created_at))
      || Object.values(data).some((item) => !(item === null || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)))
      || !(data.notes === null || typeof data.notes === 'string')) return invalid();
    if (value.entity === 'interaction') {
      if (!dateOnly(data.date) || !['call', 'message', 'meetup', 'email'].includes(String(data.type))
        || !(data.summary === null || typeof data.summary === 'string')
        || !(data.occurred_at === null || timestamp(data.occurred_at) && new Date(data.occurred_at).toISOString().slice(0, 10) === data.date)) return invalid();
    } else if (typeof data.title !== 'string' || !data.title.trim() || !timestamp(data.remind_at)
      || !(data.completed_at === null || timestamp(data.completed_at))) return invalid();
  }
  return value as SyncEntityRecord;
}

export function readBootstrapV2(value: unknown) {
  if (!object(value) || value.version !== 2 || !Array.isArray(value.entities) || value.entities.length !== SYNC_V2_ENTITIES.length
    || value.entities.some((entity, index) => entity !== SYNC_V2_ENTITIES[index]) || !Array.isArray(value.records)
    || value.records.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor), records = value.records.map(readSyncV2Record);
  if (records.some((record, index) => record.deleted || index > 0 && position(record) <= position(records[index - 1]))) return invalid();
  let next: SyncV2BootstrapPosition | null = null;
  if (value.next !== null) {
    const current = readSyncCursor(value.next);
    const last = records.at(-1);
    if (!object(value.next) || !isSyncUuid(value.next.after) || !isEntity(value.next.entity)
      || current.epoch !== cursor.epoch || current.sequence !== cursor.sequence
      || !last || last.id !== value.next.after || last.entity !== value.next.entity) return invalid();
    next = { ...current, after: value.next.after, entity: value.next.entity };
  }
  return { cursor, records, next };
}

export function readPullV2(value: unknown, previous: SyncCursor) {
  if (!object(value) || value.version !== 2 || typeof value.more !== 'boolean'
    || !Array.isArray(value.changes) || value.changes.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor);
  if (cursor.epoch !== previous.epoch || cursor.sequence < previous.sequence) return invalid();
  let sequence = previous.sequence;
  const records = value.changes.map((change) => {
    if (!object(change) || !isEntity(change.entity) || !isSyncSequence(change.sequence)
      || change.sequence <= sequence || change.sequence > cursor.sequence) return invalid();
    const record = readSyncV2Record(change.record);
    if (record.entity !== change.entity) return invalid();
    sequence = change.sequence;
    return record;
  });
  if (value.more && (!records.length || sequence !== cursor.sequence)) return invalid();
  return { cursor, records, more: value.more };
}

export function readPushResultV2(value: unknown, operationId: string, entity: SyncEntity, entityId: string): SyncV2MutationResult {
  if (!object(value) || value.version !== 2 || typeof value.replayed !== 'boolean' || !object(value.result)
    || value.result.operationId !== operationId || !['applied', 'conflict'].includes(String(value.result.status))) return invalid();
  const record = value.result.record === null ? null : readSyncV2Record(value.result.record);
  if (record && (record.entity !== entity || record.id !== entityId) || value.result.status === 'applied' && !record) return invalid();
  const canonicalRecord = readCanonicalContactRecord(value.result.canonicalRecord, record);
  if (canonicalRecord && (entity !== 'contact' || (canonicalRecord as SyncEntityRecord).entity !== 'contact')) return invalid();
  return { operationId, status: value.result.status as SyncV2MutationResult['status'], record,
    ...(canonicalRecord ? { canonicalRecord: { ...canonicalRecord, entity: 'contact' as const } } : {}) };
}
