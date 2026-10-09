import { isSyncSequence, isSyncUuid, MAX_SYNC_RECORD_BYTES, SYNC_PAGE_SIZE,
  type SyncContactRecord, type SyncCursor, type SyncMutationResult } from './sync.ts';
import { readContactMergeAliases } from './contact-aliases.ts';
import { readContactMethods } from './contact-methods.ts';
import { readContactSources } from './contact-sources.ts';
import { readProviderSources } from './provider-sources.ts';
import { readDeviceSources } from './device-sources.ts';

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('The server returned an invalid sync response. Keep offline data and retry.'); }

export function readSyncCursor(value: unknown): SyncCursor {
  if (!object(value) || !isSyncUuid(value.epoch) || !isSyncSequence(value.sequence)) return invalid();
  return { epoch: value.epoch, sequence: value.sequence };
}

export function readSyncRecord(value: unknown): SyncContactRecord {
  if (!object(value) || !isSyncUuid(value.id) || !isSyncSequence(value.legacyId) || value.legacyId < 1
    || !isSyncSequence(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean') return invalid();
  if (value.deleted) { if (value.data !== null) return invalid(); }
  else {
    if (!object(value.data) || typeof value.data.name !== 'string' || !value.data.name.trim()
      || typeof value.data.contact_frequency !== 'number' || !Number.isInteger(value.data.contact_frequency)
      || value.data.contact_frequency < 1 || value.data.contact_frequency > 3650
      || typeof value.data.created_at !== 'string' || typeof value.data.updated_at !== 'string'
      || Object.values(value.data).some((item) => !(item === null || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)))
      || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SYNC_RECORD_BYTES) return invalid();
    for (const key of ['email', 'phone', 'birthday', 'how_we_met', 'notes', 'last_contacted']) {
      if (value.data[key] !== null && typeof value.data[key] !== 'string') return invalid();
    }
    try { readContactMergeAliases(value.data.merge_aliases, value.id); } catch { return invalid(); }
    try { readContactMethods(value.data.contact_methods); } catch { return invalid(); }
    try { readContactSources(value.data.source_links); } catch { return invalid(); }
    try { readProviderSources(value.data.provider_links); } catch { return invalid(); }
    try { readDeviceSources(value.data.device_links); } catch { return invalid(); }
  }
  if (value.mergedIntoId !== undefined && (!value.deleted || !isSyncUuid(value.mergedIntoId) || value.mergedIntoId === value.id)) return invalid();
  return value as SyncContactRecord;
}

export function readBootstrap(value: unknown) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entities) || value.entities.length !== 1
    || value.entities[0] !== 'contact' || !Array.isArray(value.records) || value.records.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor), records = value.records.map(readSyncRecord);
  if (records.some((record, index) => index > 0 && record.id <= records[index - 1].id)) return invalid();
  let next: (SyncCursor & { after: string }) | null = null;
  if (value.next !== null) {
    const position = readSyncCursor(value.next);
    if (!object(value.next) || !isSyncUuid(value.next.after) || position.epoch !== cursor.epoch
      || position.sequence !== cursor.sequence || !records.length || value.next.after !== records.at(-1)!.id) return invalid();
    next = { ...position, after: value.next.after };
  }
  return { cursor, records, next };
}

export function readPull(value: unknown, previous: SyncCursor) {
  if (!object(value) || value.version !== 1 || typeof value.more !== 'boolean'
    || !Array.isArray(value.changes) || value.changes.length > SYNC_PAGE_SIZE) return invalid();
  const cursor = readSyncCursor(value.cursor);
  if (cursor.epoch !== previous.epoch || cursor.sequence < previous.sequence) return invalid();
  let sequence = previous.sequence;
  const records = value.changes.map((change) => {
    if (!object(change) || change.entity !== 'contact' || !isSyncSequence(change.sequence)
      || change.sequence <= sequence || change.sequence > cursor.sequence) return invalid();
    sequence = change.sequence;
    return readSyncRecord(change.record);
  });
  if (value.more && (!records.length || sequence !== cursor.sequence)) return invalid();
  return { cursor, records, more: value.more };
}

export function readPushResult(value: unknown, operationId: string, contactId: string): SyncMutationResult {
  if (!object(value) || value.version !== 1 || typeof value.replayed !== 'boolean' || !object(value.result)
    || value.result.operationId !== operationId || !['applied', 'conflict'].includes(String(value.result.status))) return invalid();
  const record = value.result.record === null ? null : readSyncRecord(value.result.record);
  if (record && record.id !== contactId || value.result.status === 'applied' && !record) return invalid();
  const canonicalRecord = readCanonicalContactRecord(value.result.canonicalRecord, record);
  return { operationId, status: value.result.status as SyncMutationResult['status'], record, ...(canonicalRecord ? { canonicalRecord } : {}) };
}

export function readCanonicalContactRecord(value: unknown, source: SyncContactRecord | null): SyncContactRecord | undefined {
  if (value === undefined) return undefined;
  const canonical = readSyncRecord(value);
  if (!source?.deleted || source.mergedIntoId !== canonical.id || canonical.id === source.id) return invalid();
  return canonical;
}
