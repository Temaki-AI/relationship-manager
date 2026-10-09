import { isSyncSequence, isSyncUuid, MAX_SYNC_RECORD_BYTES, SYNC_PAGE_SIZE, type SyncCursor } from './sync.ts';
import { readSyncCursor, readCanonicalContactRecord } from './sync-client.ts';
import { SYNC_V3_ENTITIES } from './sync-v3.ts';
import { readSyncV3Record } from './sync-v3-client.ts';
import { readCalendarEventFacts } from './calendar-events.ts';
import { SYNC_V4_ENTITIES, type SyncV4Entity, type SyncV4EntityRecord, type SyncV4BootstrapPosition, type SyncV4MutationResult } from './sync-v4.ts';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('The server returned an invalid sync response. Keep offline data and retry.'); }
function isEntity(value: unknown): value is SyncV4Entity { return (SYNC_V4_ENTITIES as readonly unknown[]).includes(value); }
export function calendarContextIds(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 8192) return invalid();
  let ids: unknown; try { ids = JSON.parse(value); } catch { return invalid(); }
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !isSyncUuid(id)) || new Set(ids).size !== ids.length) return invalid();
  return ids as string[];
}
function position(record: SyncV4EntityRecord) { return `${record.entity}:${record.id}`; }

export function readSyncV4Record(value: unknown): SyncV4EntityRecord {
  if (!object(value) || !isEntity(value.entity)) return invalid();
  if ((SYNC_V3_ENTITIES as readonly unknown[]).includes(value.entity)) return readSyncV3Record(value);
  const recordKeys = ['entity', 'id', 'legacyId', 'revision', 'deleted', 'data'];
  if (Object.keys(value).length !== recordKeys.length || Object.keys(value).some((key) => !recordKeys.includes(key))
    || !isSyncUuid(value.id) || !isSyncSequence(value.legacyId) || value.legacyId < 1
    || !isSyncSequence(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean'
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SYNC_RECORD_BYTES) return invalid();
  if (value.deleted) { if (value.data !== null) return invalid(); }
  else {
    const data = value.data;
    const keys = ['provider', 'account_email', 'calendar_label', 'calendar_time_zone', 'observed_at', 'source_status', 'facts', 'contact_ids', 'plan_ids'];
    if (!object(data) || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) || Object.values(data).some((item) => typeof item !== 'string')
      || data.provider !== 'google-calendar' || typeof data.source_status !== 'string' || !['available', 'unavailable', 'review_required'].includes(data.source_status)
      || typeof data.account_email !== 'string' || data.account_email.length > 320 || /[\u0000-\u001f\u007f]/u.test(data.account_email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(data.account_email)
      || typeof data.calendar_label !== 'string' || !data.calendar_label.trim() || data.calendar_label.length > 512 || /[\u0000-\u001f\u007f]/u.test(data.calendar_label)
      || typeof data.calendar_time_zone !== 'string' || !data.calendar_time_zone || data.calendar_time_zone.length > 100
      || typeof data.observed_at !== 'string' || data.observed_at.length > 40 || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(data.observed_at) || !Number.isFinite(Date.parse(data.observed_at))
      || typeof data.facts !== 'string' || new TextEncoder().encode(data.facts).byteLength > 65536) return invalid();
    try { new Intl.DateTimeFormat('en', { timeZone: data.calendar_time_zone }); readCalendarEventFacts(JSON.parse(data.facts)); calendarContextIds(data.contact_ids); calendarContextIds(data.plan_ids); } catch { return invalid(); }
  }
  return value as SyncV4EntityRecord;
}

export function readBootstrapV4(value: unknown) {
  if (!object(value) || value.version !== 4 || !Array.isArray(value.entities) || value.entities.length !== SYNC_V4_ENTITIES.length
    || value.entities.some((entity, index) => entity !== SYNC_V4_ENTITIES[index]) || !Array.isArray(value.records)
    || value.records.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor), records = value.records.map(readSyncV4Record);
  if (records.some((record, index) => record.deleted || index > 0 && position(record) <= position(records[index - 1]))) return invalid();
  let next: SyncV4BootstrapPosition | null = null;
  if (value.next !== null) {
    const current = readSyncCursor(value.next), last = records.at(-1);
    if (!object(value.next) || !isSyncUuid(value.next.after) || !isEntity(value.next.entity)
      || current.epoch !== cursor.epoch || current.sequence !== cursor.sequence
      || !last || last.id !== value.next.after || last.entity !== value.next.entity) return invalid();
    next = { ...current, after: value.next.after, entity: value.next.entity };
  }
  return { cursor, records, next };
}

export function readPullV4(value: unknown, previous: SyncCursor) {
  if (!object(value) || value.version !== 4 || typeof value.more !== 'boolean'
    || !Array.isArray(value.changes) || value.changes.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor);
  if (cursor.epoch !== previous.epoch || cursor.sequence < previous.sequence) return invalid();
  let sequence = previous.sequence;
  const records = value.changes.map((change) => {
    if (!object(change) || !isEntity(change.entity) || !isSyncSequence(change.sequence)
      || change.sequence <= sequence || change.sequence > cursor.sequence) return invalid();
    const record = readSyncV4Record(change.record);
    if (record.entity !== change.entity) return invalid();
    sequence = change.sequence;
    return record;
  });
  if (value.more && (!records.length || sequence !== cursor.sequence)) return invalid();
  return { cursor, records, more: value.more };
}

export function readPushResultV4(value: unknown, operationId: string, entity: SyncV4Entity, entityId: string): SyncV4MutationResult {
  if (!object(value) || value.version !== 4 || typeof value.replayed !== 'boolean' || !object(value.result)
    || value.result.operationId !== operationId || typeof value.result.status !== 'string' || !['applied', 'conflict'].includes(value.result.status)) return invalid();
  const record = value.result.record === null ? null : readSyncV4Record(value.result.record);
  if (record && (record.entity !== entity || record.id !== entityId) || value.result.status === 'applied' && !record) return invalid();
  const canonicalRecord = readCanonicalContactRecord(value.result.canonicalRecord, record);
  if (canonicalRecord && (entity !== 'contact' || (canonicalRecord as SyncV4EntityRecord).entity !== 'contact')) return invalid();
  return { operationId, status: value.result.status as SyncV4MutationResult['status'], record,
    ...(canonicalRecord ? { canonicalRecord: { ...canonicalRecord, entity: 'contact' as const } } : {}) };
}
